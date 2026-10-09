/*
 * 心悦俱乐部悦享卡每日奖励自动领取脚本 v9.1 (免点击版)
 *
 * 作者: TimeJason
 * 更新日期: 2026-10-09
 *
 * 核心思路:
 *   抓取并保存一次完整的领奖参数 (token + headers + 重建的 body), 之后定时重放。
 *
 * 免点击抓取 (多钩子 + 字段合并):
 *   打开"悦享卡"页面即会触发以下任一接口, 脚本据此自动抓取, 无需手动点"领取":
 *     - GetCardBuyStatus : 打开卡片页必发, 请求体 = 领奖体(去掉 num/record_id/user_info)
 *     - GetCardInfo      : 打开"已开通卡的详情"页时发, 请求体含 record_id
 *     - ReceiveGift      : 点击"领取"时发, 是最精确的领奖体(含 user_info)
 *   多钩子抓到的数据按来源分别保存, 读取时按优先级取舍:
 *     ReceiveGift > GetCardInfo > GetCardBuyStatus
 *   因此随便打开一次相关页面即可攒齐参数, 且不会被"没开通的卡"的字段带偏。
 *
 * 相比 v9.0:
 *   - 新增 GetCardBuyStatus 钩子, 大幅提高"进页面即抓到"的成功率
 *   - 抓取改为"字段合并", 不同接口互补, 不再要求一次抓全
 */

const $ = new Env('心悦俱乐部');
const notify = $.isNode() ? require('./sendNotify') : '';

// --- BoxJs Keys ---
const XINYUE_DATA_KEY = 'xinyue_datas';
const KEY_NOTIFY_SUCCESS = 'xinyue_notify_success';
const KEY_DEBUG_LOG = 'xinyue_debug_log';

// --- 接口 ---
const HOOK_RECEIVE = '/XyCard.CardSrv/ReceiveGift';       // 点击领取, 精确抓取
const HOOK_GETCARD = '/XyCard.CardSrv/GetCardInfo';       // 已开通卡详情, 含 record_id
const HOOK_BUYSTATUS = '/XyCard.CardSrv/GetCardBuyStatus'; // 卡片页必发, 含 role
const HOOKS = [HOOK_BUYSTATUS, HOOK_GETCARD, HOOK_RECEIVE];
const CLAIM_URL = 'https://bgw.xinyue.qq.com/XyCard.CardSrv/ReceiveGift';

// 数据来源优先级: ReceiveGift > GetCardInfo > GetCardBuyStatus
// 原因: GetCardBuyStatus 在任意卡片页都会发(可能是没有的卡), 字段最不可靠;
//       GetCardInfo 只在"已开通卡详情"页发; ReceiveGift 是真实领奖包, 最权威。
const SOURCE_ORDER = ['receive', 'getcard', 'buystatus'];
const SOURCE_LABEL = {
    receive: '精确抓取 (ReceiveGift)',
    getcard: '免点击抓取 (GetCardInfo)',
    buystatus: '免点击抓取 (GetCardBuyStatus)'
};

if (typeof $request !== 'undefined') {
    // 重写模式: 抓取参数
    if ($request.url && HOOKS.some((u) => $request.url.includes(u))) {
        captureCredentials();
    }
    $.done();
} else {
    // 定时任务模式
    (async () => {
        $.log('进入定时任务模式...');
        await runTasks();
    })().catch((e) => $.logErr(e)).finally(() => $.done());
}

/* ============================ 抓取 ============================ */

function captureCredentials() {
    if ($request.method !== 'POST') {
        return $.log(`捕获到非 POST(${$request.method}) 请求, 已跳过。`);
    }
    if (!$request.body) return;

    const headers = $request.headers || {};
    const token = headers['T-ACCESS-TOKEN'] || headers['t-access-token'];
    const openid = headers['T-OPENID'] || headers['t-openid'];
    if (!token || !openid) return;

    let body;
    try { body = JSON.parse($request.body); }
    catch (e) { return; }

    const sourceKey = $request.url.includes(HOOK_RECEIVE) ? 'receive'
        : $request.url.includes(HOOK_GETCARD) ? 'getcard'
        : 'buystatus';

    let accounts = $.toObj($.getdata(XINYUE_DATA_KEY), []);
    if (!Array.isArray(accounts)) accounts = [];
    const idx = accounts.findIndex((a) => a.openid === openid);
    const prev = idx > -1 ? accounts[idx] : {};

    // 按来源分别保存原始包, 读取时按优先级解析, 避免低优先级覆盖高优先级
    const sources = { ...(prev.sources || {}) };
    sources[sourceKey] = body;

    const resolved = resolveSources(sources);

    // user_info: ReceiveGift 自带, 否则复用历史缓存
    let userInfo = prev.userInfo || null;
    if (sources.receive && sources.receive.user_info
        && (sources.receive.user_info.nickname || sources.receive.user_info.avatar)) {
        userInfo = sources.receive.user_info;
    }

    let roleName = prev.roleName || '';
    if (resolved.role && resolved.role.role_name) {
        const decoded = b64DecodeUtf8(resolved.role.role_name);
        if (decoded) roleName = decoded;
    }

    // 领奖 body: 有真实的 ReceiveGift 包就直接用, 否则用合并字段重建
    const claimBody = sources.receive
        ? JSON.stringify(sources.receive)
        : buildClaimBody(resolved, userInfo);
    const nickname = (userInfo && userInfo.nickname && userInfo.nickname.trim())
        || roleName || `用户_${openid.slice(0, 6)}`;

    const account = {
        token,
        openid,
        nickname,
        roleName,
        sources,
        card_id: resolved.card_id || '',
        record_id: resolved.record_id || '',
        headers,
        user_info: userInfo,
        claimBody,
        updatedAt: new Date().toISOString()
    };

    const label = SOURCE_LABEL[sourceKey];
    const card = resolved.card_id || '?';
    if (idx > -1) {
        accounts[idx] = account;
        $.msg($.name, '✅ 配置已更新', `账号: [${nickname}]\n来源: ${label}\n卡片: ${card}`);
    } else {
        accounts.push(account);
        $.msg($.name, '✅ 配置已添加', `账号: [${nickname}]\n来源: ${label}\n卡片: ${card}`);
    }
    $.setdata(JSON.stringify(accounts), XINYUE_DATA_KEY);
    $.log(`当前共 ${accounts.length} 个账号。`);
}

// 从各来源中按优先级挑出最可靠的一份字段
// 卡片字段整体取"最高优先级且含 card_id"的那一份, 避免把 A 卡的 gid 和 B 卡的 card_id 拼在一起
function resolveSources(sources) {
    const first = (pred) => {
        for (const k of SOURCE_ORDER) {
            const b = sources[k];
            if (b && pred(b)) return b;
        }
        return null;
    };
    const card = first((b) => b.card_id) || {};
    const roleSrc = first((b) => b.role && b.role.role_id) || {};
    const recSrc = first((b) => b.record_id);
    return {
        gid: card.gid,
        card_group: card.card_group,
        card_type: card.card_type,
        card_id: card.card_id,
        channel: card.channel,
        pay_channel: card.pay_channel,
        role: roleSrc.role,
        record_id: recSrc ? recSrc.record_id : ''
    };
}

// 用合并后的字段重建 ReceiveGift 的 body
function buildClaimBody(fields, userInfo) {
    return JSON.stringify({
        gid: fields.gid,
        card_group: fields.card_group,
        card_type: fields.card_type,
        card_id: fields.card_id,
        channel: fields.channel || 'vip',
        pay_channel: fields.pay_channel || 'iap',
        platform: 'ios',                    // 领奖必须用 ios
        role: fields.role,
        num: 1,
        record_id: fields.record_id || '',
        user_info: userInfo || { avatar: '', nickname: '' }
    });
}

/* ========================== 定时领取 ========================== */

async function runTasks() {
    const accountsStr = $.getdata(XINYUE_DATA_KEY);
    if (!accountsStr) {
        return $.msg($.name, '❌ 未找到配置', '请先打开一次"悦享卡"页面以完成初始化。');
    }
    const accounts = $.toObj(accountsStr, []);
    if (!accounts.length) return;

    $.log(`共发现 ${accounts.length} 个账号, 开始执行...`);
    const summary = [];
    let allOk = true;
    for (let i = 0; i < accounts.length; i++) {
        $.index = i + 1;
        const line = await claimReward(accounts[i]);
        if (line.includes('❌')) allOk = false;
        summary.push(line);
        if (i < accounts.length - 1) await $.wait(2000);
    }

    const notifySuccess = $.getdata(KEY_NOTIFY_SUCCESS) !== 'false';
    const title = `心悦悦享卡 (${$.time('MM-dd')})`;
    if (allOk && !notifySuccess) {
        $.log('全部成功/重复, 按设置不发送通知。');
    } else {
        $.msg($.name, title, summary.join('\n'));
    }
}

function claimReward(acc) {
    return new Promise((resolve) => {
        const { token, openid, nickname, headers, claimBody } = acc;
        if (!headers || !claimBody) {
            return resolve(`👤 [${nickname || openid}]: ❌ 缺少配置, 请重新抓取。`);
        }

        const dynamicHeaders = { ...headers };
        dynamicHeaders['T-ACCESS-TOKEN'] = token;
        dynamicHeaders['T-OPENID'] = openid;
        delete dynamicHeaders['Content-Length'];

        $.log(`\n▶️ [${nickname}] 开始领取...`);
        $.post({ url: CLAIM_URL, method: 'POST', headers: dynamicHeaders, body: claimBody }, (error, response, data) => {
            if ($.getdata(KEY_DEBUG_LOG) === 'true') $.log(`[调试] ${nickname} 原始响应: ${data}`);
            resolve(summarize(nickname, error, data));
        });
    });
}

function summarize(nickname, error, data) {
    const head = `👤 [${nickname}]: `;
    try {
        if (error) throw new Error(error);
        const res = JSON.parse(data);

        if (res.ret !== 0) {
            let msg = `❌ 领取失败 - ${res.msg || ('ret=' + res.ret)}`;
            if (res.ret === 7006 && res.msg === 'tourist mode') msg += ' (配置/角色不匹配, 请重新抓取)';
            else if (/token/i.test(res.msg || '')) msg += ' (Token 可能已失效, 请重新抓取)';
            else msg += ' (如持续失败, 请打开一次悦享卡页面重抓参数)';
            return head + msg;
        }

        const gifts = res.data && res.data.gift_info;
        if (Array.isArray(gifts) && gifts.length) {
            const desc = gifts.map((g) =>
                `${g.title || ''}：${(g.items || []).map((it) => `${it.name}x${it.quantity}`).join('、')}`
            ).join('；');
            return head + `✅ 领取成功 - ${desc}`;
        }
        if (res.data && res.data.pop_info && /已领取|已领/.test(res.data.pop_info.content || '')) {
            return head + '🔁 今日已领取';
        }
        return head + '✅ 操作成功 (无可领奖励或今日已领)';
    } catch (e) {
        return head + '❌ 请求异常或返回数据非 JSON';
    }
}

/* ====================== 工具: base64 -> UTF-8 ====================== */

function b64DecodeUtf8(str) {
    try {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let out = '', buffer = 0, bits = 0;
        for (let i = 0; i < str.length; i++) {
            const c = str.charAt(i);
            if (c === '=') break;
            const v = chars.indexOf(c);
            if (v === -1) continue;
            buffer = (buffer << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out += String.fromCharCode((buffer >> bits) & 0xff);
            }
        }
        return decodeURIComponent(out.split('').map((ch) => '%' + ('00' + ch.charCodeAt(0).toString(16)).slice(-2)).join(''));
    } catch (e) { return ''; }
}

/* ============================ Env ============================ */

function Env(t,e){class s{constructor(t){this.env=t}send(t,e="GET"){t="string"==typeof t?{url:t}:t;let s=this.get;return"POST"===e&&(s=this.post),new Promise((e,i)=>{s.call(this,t,(t,s,r)=>{t?i(t):e(s)})})}get(t){return this.send.call(this.env,t)}post(t){return this.send.call(this.env,t,"POST")}}return new class{constructor(t,e){this.name=t,this.http=new s(this),this.data=null,this.dataFile="box.dat",this.logs=[],this.isMute=!1,this.isNeedRewrite=!1,this.logSeparator="\n",this.startTime=(new Date).getTime(),Object.assign(this,e),this.log("",`🔔${this.name}, 开始!`)}isNode(){return"undefined"!=typeof module&&!!module.exports}isQuanX(){return"undefined"!=typeof $task}isSurge(){return"undefined"!=typeof $httpClient&&"undefined"==typeof $loon}isLoon(){return"undefined"!=typeof $loon}toObj(t,e=null){try{return JSON.parse(t)}catch{return e}}toStr(t,e=null){try{return JSON.stringify(t)}catch{return e}}getjson(t,e){let s=e;const i=this.getdata(t);if(i)try{s=JSON.parse(this.getdata(t))}catch{}return s}setjson(t,e){try{return this.setdata(JSON.stringify(t),e)}catch{return!1}}getScript(t){return new Promise(e=>{this.get({url:t},(t,s,i)=>e(i))})}runScript(t,e){return new Promise(s=>{let i=this.getdata("@chavy_boxjs_userCfgs.httpapi");i=i?i.replace(/\n/g,"").trim():i;let r=this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout");r=r?1*r:20,r=e&&e.timeout?e.timeout:r;const[o,h]=i.split("@"),a={url:`http://${h}/v1/scripting/evaluate`,body:{script_text:t,mock_type:"cron",timeout:r},headers:{"X-Key":o,Accept:"*/*"}};this.post(a,(t,e,i)=>s(i))}).catch(t=>this.logErr(t))}loaddata(){if(!this.isNode())return{};{this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e);if(!s&&!i)return{};{const i=s?t:e;try{return JSON.parse(this.fs.readFileSync(i))}catch(t){return{}}}}}writedata(){if(this.isNode()){this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e),r=JSON.stringify(this.data);s?this.fs.writeFileSync(t,r):i?this.fs.writeFileSync(e,r):this.fs.writeFileSync(t,r)}}lodash_get(t,e,s){const i=e.replace(/\[(\d+)\]/g,".$1").split(".");let r=t;for(const t of i)if(r=Object(r)[t],void 0===r)return s;return r}lodash_set(t,e,s){return Object(t)!==t?t:(Array.isArray(e)||(e=e.toString().match(/[^.[\]]+/g)||[]),e.slice(0,-1).reduce((t,s,i)=>Object(t[s])===t[s]?t[s]:t[s]=Math.abs(e[i+1])>>0==+e[i+1]?[]:{},t)[e[e.length-1]]=s,t)}getdata(t){let e=this.getval(t);if(/^@/.test(t)){const[,s,i]=/^@(.*?)\.(.*?)$/.exec(t),r=s?this.getval(s):"";if(r)try{const t=JSON.parse(r);e=t?this.lodash_get(t,i,""):e}catch(t){e=""}}return e}setdata(t,e){let s=!1;if(/^@/.test(e)){const[,i,r]=/^@(.*?)\.(.*?)$/.exec(e),o=this.getval(i),h=i?"null"===o?null:o||"{}":"{}";try{const e=JSON.parse(h);this.lodash_set(e,r,t),s=this.setval(JSON.stringify(e),i)}catch(e){const o={};this.lodash_set(o,r,t),s=this.setval(JSON.stringify(o),i)}}else s=this.setval(t,e);return s}getval(t){return this.isSurge()||this.isLoon()?$persistentStore.read(t):this.isQuanX()?$prefs.valueForKey(t):this.isNode()?(this.data=this.loaddata(),this.data[t]):this.data&&this.data[t]||null}setval(t,e){return this.isSurge()||this.isLoon()?$persistentStore.write(t,e):this.isQuanX()?$prefs.setValueForKey(t,e):this.isNode()?(this.data=this.loaddata(),this.data[e]=t,this.writedata(),!0):this.data&&this.data[e]||null}initGotEnv(t){this.got=this.got?this.got:require("got"),this.cktough=this.cktough?this.cktough:require("tough-cookie"),this.ckjar=this.ckjar?this.ckjar:new this.cktough.CookieJar,t&&(t.headers=t.headers?t.headers:{},void 0===t.headers.Cookie&&void 0===t.cookieJar&&(t.cookieJar=this.ckjar))}get(t,e=(()=>{})){t.headers&&(delete t.headers["Content-Type"],delete t.headers["Content-Length"]),this.isSurge()||this.isLoon()?(this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient.get(t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status),e(t,s,i)})):this.isQuanX()?(this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>e(t))):this.isNode()&&(this.initGotEnv(t),this.got(t).on("redirect",(t,e)=>{try{if(t.headers["set-cookie"]){const s=t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString();this.ckjar.setCookieSync(s,null),e.cookieJar=this.ckjar}}catch(t){this.logErr(t)}}).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>{const{message:s,response:i}=t;e(s,i,i&&i.body)}))}post(t,e=(()=>{})){if(t.body&&t.headers&&!t.headers["Content-Type"]&&(t.headers["Content-Type"]="application/x-www-form-urlencoded"),t.headers&&delete t.headers["Content-Length"],this.isSurge()||this.isLoon())this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient.post(t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status),e(t,s,i)});else if(this.isQuanX())t.method="POST",this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>e(t));else if(this.isNode()){this.initGotEnv(t);const{url:s,...i}=t;this.got.post(s,i).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>{const{message:s,response:i}=t;e(s,i,i&&i.body)})}}time(t){let e={"M+":(new Date).getMonth()+1,"d+":(new Date).getDate(),"H+":(new Date).getHours(),"m+":(new Date).getMinutes(),"s+":(new Date).getSeconds(),"q+":Math.floor(((new Date).getMonth()+3)/3),S:(new Date).getMilliseconds()};/(y+)/.test(t)&&(t=t.replace(RegExp.$1,((new Date).getFullYear()+"").substr(4-RegExp.$1.length)));for(let s in e)new RegExp("("+s+")").test(t)&&(t=t.replace(RegExp.$1,1==RegExp.$1.length?e[s]:("00"+e[s]).substr((""+e[s]).length)));return t}msg(e=t,s="",i="",r){const o=t=>{if(!t)return t;if("string"==typeof t)return this.isLoon()?t:this.isQuanX()?{"open-url":t}:this.isSurge()?{url:t}:void 0;if("object"==typeof t){if(this.isLoon()){let e=t.openUrl||t.url||t["open-url"],s=t.mediaUrl||t["media-url"];return{openUrl:e,mediaUrl:s}}if(this.isQuanX()){let e=t["open-url"]||t.url||t.openUrl,s=t["media-url"]||t.mediaUrl;return{"open-url":e,"media-url":s}}if(this.isSurge()){let e=t.url||t.openUrl||t["open-url"];return{url:e}}}};this.isMute||(this.isSurge()||this.isLoon()?$notification.post(e,s,i,o(r)):this.isQuanX()&&$notify(e,s,i,o(r)));let h=["","==============📣系统通知📣=============="];h.push(e),s&&h.push(s),i&&h.push(i),console.log(h.join("\n")),this.logs=this.logs.concat(h)}log(...t){t.length>0&&(this.logs=[...this.logs,...t]),console.log(t.join(this.logSeparator))}logErr(t,e){const s=!this.isSurge()&&!this.isQuanX()&&!this.isLoon();s?this.log("",`❗️${this.name}, 错误!`,t.stack):this.log("",`❗️${this.name}, 错误!`,t)}wait(t){return new Promise(e=>setTimeout(e,t))}done(t={}){const e=(new Date).getTime(),s=(e-this.startTime)/1e3;this.log("",`🔔${this.name}, 结束! 🕛 ${s} 秒`),this.log(),(this.isSurge()||this.isQuanX()||this.isLoon())&&$done(t)}}(t,e)}
