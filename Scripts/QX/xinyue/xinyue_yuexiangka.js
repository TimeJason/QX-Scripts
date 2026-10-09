/*
 * 心悦俱乐部悦享卡每日奖励自动领取脚本 v9.0 (免点击版)
 *
 * 作者: TimeJason
 * 更新日期: 2026-10-09
 *
 * 相比 v8.8 的改动:
 *   1. 免点击: 只需进入"悦享卡"页面(触发 GetCardInfo)即可自动抓取 token/角色/记录ID,
 *      无需再手动点一次"领取"。GetCardInfo 的请求头带 token, 请求体带 role 和 record_id。
 *   2. 点击"领取"(ReceiveGift)时抓取最精确的 body, 并缓存其中的 user_info, 覆盖第 1 步的数据。
 *   3. 修复奖励名称上报错误(gift_info 是数组, 原来只取 [0] 会报成"续费开通礼包")。
 *   4. 统一非 0 返回值的失败提示; 角色名从 role_name(base64) 自动解码用于通知。
 */

const $ = new Env('心悦俱乐部');
const notify = $.isNode() ? require('./sendNotify') : '';

// --- BoxJs Keys ---
const XINYUE_DATA_KEY = 'xinyue_datas';
const KEY_NOTIFY_SUCCESS = 'xinyue_notify_success';
const KEY_DEBUG_LOG = 'xinyue_debug_log';

// --- 接口 ---
const HOOK_GETCARD = '/XyCard.CardSrv/GetCardInfo';   // 进入页面触发, 免点击抓取
const HOOK_RECEIVE = '/XyCard.CardSrv/ReceiveGift';   // 点击领取触发, 精确抓取
const CLAIM_URL = 'https://bgw.xinyue.qq.com/XyCard.CardSrv/ReceiveGift';

if (typeof $request !== 'undefined') {
    // 重写模式: 抓取参数
    if ($request.url && ($request.url.includes(HOOK_GETCARD) || $request.url.includes(HOOK_RECEIVE))) {
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
    if (!$request.body) return $.msg($.name, '获取失败', '未读取到请求体 (Body)。');

    const headers = $request.headers || {};
    const token = headers['T-ACCESS-TOKEN'] || headers['t-access-token'];
    const openid = headers['T-OPENID'] || headers['t-openid'];
    if (!token || !openid) return $.msg($.name, '获取失败', '未从请求头找到身份凭证 (token/openid)。');

    let body;
    try { body = JSON.parse($request.body); }
    catch (e) { return $.msg($.name, '获取失败', '请求体不是合法 JSON。'); }

    const isClaim = $request.url.includes(HOOK_RECEIVE);

    let accounts = $.toObj($.getdata(XINYUE_DATA_KEY), []);
    if (!Array.isArray(accounts)) accounts = [];
    const idx = accounts.findIndex((a) => a.openid === openid);
    const prev = idx > -1 ? accounts[idx] : {};

    // 角色名: role_name 是 base64, 解出真实角色名
    let roleName = prev.roleName || '';
    if (body.role && body.role.role_name) {
        const decoded = b64DecodeUtf8(body.role.role_name);
        if (decoded) roleName = decoded;
    }

    // user_info: 优先本次(通常来自 ReceiveGift), 其次复用历史缓存
    let userInfo = prev.userInfo || null;
    if (body.user_info && (body.user_info.nickname || body.user_info.avatar)) {
        userInfo = body.user_info;
    }

    // 领奖 body: 点领取时用抓到的原始包; 进页面时用 GetCardInfo 的 body 现场重建
    const claimBody = isClaim ? $request.body : buildClaimBody(body, userInfo);
    const nickname = (userInfo && userInfo.nickname && userInfo.nickname.trim())
        || roleName || `用户_${openid.slice(0, 6)}`;

    const account = {
        token,
        openid,
        nickname,
        roleName,
        record_id: body.record_id,
        headers,
        user_info: userInfo,
        claimBody,
        updatedAt: new Date().toISOString()
    };

    const source = isClaim ? '精确抓取 (ReceiveGift)' : '免点击抓取 (GetCardInfo)';
    if (idx > -1) {
        accounts[idx] = account;
        $.msg($.name, '✅ 配置已更新', `账号: [${nickname}]\n来源: ${source}`);
    } else {
        accounts.push(account);
        $.msg($.name, '✅ 配置已添加', `账号: [${nickname}]\n来源: ${source}`);
    }
    $.setdata(JSON.stringify(accounts), XINYUE_DATA_KEY);
    $.log(`当前共 ${accounts.length} 个账号。`);
}

// 用 GetCardInfo 的 body 重建 ReceiveGift 的 body
function buildClaimBody(src, userInfo) {
    return JSON.stringify({
        gid: src.gid,
        card_group: src.card_group,
        card_type: src.card_type,
        card_id: src.card_id,
        channel: src.channel || 'vip',
        pay_channel: src.pay_channel || 'iap',
        platform: 'ios',                    // GetCardInfo 用 tgclubApp, 领奖必须用 ios
        role: src.role,
        num: 1,                             // 领奖新增
        record_id: src.record_id,
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
