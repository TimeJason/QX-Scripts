/*
 * 心悦俱乐部悦享卡每日奖励自动领取脚本 v8.8 (最终纯净版)
 *
 * 作者: TimeJason
 * 更新日期: 2025-08-10
 *
 * 功能:
 *   - 通过“点击领取”操作，一次性抓取并保存所有必需的参数（含完整的 Headers）。
 *   - 定时任务自动执行，并对成功/失败/重复状态进行美化通知。
 *   - 脚本已做兼容性处理，确保在 Quantumult X 等环境中稳定运行。
 */

const $ = new Env('心悦俱乐部');
const notify = $.isNode() ? require('./sendNotify') : '';

// --- BoxJs Keys ---
const XINYUE_DATA_KEY = 'xinyue_datas';
const KEY_NOTIFY_SUCCESS = 'xinyue_notify_success';
const KEY_DEBUG_LOG = 'xinyue_debug_log';


if (typeof $request !== 'undefined' && $request.url.includes('/ReceiveGift')) {
    $.log('进入数据获取模式 (通过 ReceiveGift)...');
    getAuthData();
    $.done();
} else if (typeof $request === 'undefined') {
    (async () => {
        $.log('进入定时任务模式...');
        await runTasks();
    })()
    .catch((e) => $.logErr(e))
    .finally(() => $.done());
} else {
    $.done();
}

function getAuthData() {
    if (!$request.body) return $.msg($.name, '获取失败', '未能读取到请求体 (Body)。');
    try {
        const headers = $request.headers;
        const token = headers['T-ACCESS-TOKEN'] || headers['t-access-token'];
        const openid = headers['T-OPENID'] || headers['t-openid'];
        if (!token || !openid) return $.msg($.name, '获取失败', '未能从请求头中找到身份凭证！');
        const currentBody = JSON.parse($request.body);
        const nickname = (currentBody.user_info && currentBody.user_info.nickname) || `用户_${openid.slice(0, 6)}`;
        const newAccountData = { token, openid, body: $request.body, headers, nickname };
        let accounts = $.getdata(XINYUE_DATA_KEY) ? JSON.parse($.getdata(XINYUE_DATA_KEY)) : [];
        const accountIndex = accounts.findIndex(acc => acc.openid === openid);
        if (accountIndex > -1) {
            accounts[accountIndex] = newAccountData;
            $.msg($.name, `✅ 配置更新成功`, `账号: [${nickname}]\n已更新为最新的有效配置。`);
        } else {
            accounts.push(newAccountData);
            $.msg($.name, `✅ 配置添加成功`, `账号: [${nickname}]\n已完成初始化。`);
        }
        $.setdata(JSON.stringify(accounts), XINYUE_DATA_KEY);
    } catch (e) {
        $.msg($.name, '❌ 获取失败', `处理数据时发生异常: ${e.message}`);
        $.logErr(e);
    }
}

async function runTasks() {
    const accountsStr = $.getdata(XINYUE_DATA_KEY);
    if (!accountsStr) return $.msg($.name, '❌ 未找到配置', '请先手动“点击领取”一次奖励以初始化脚本。');
    const accounts = JSON.parse(accountsStr);
    if (accounts.length === 0) return;
    $.log(`共发现 ${accounts.length} 个账号，开始执行任务...`);
    const summary = [];
    let allSuccessOrRepeat = true;
    for (let i = 0; i < accounts.length; i++) {
        $.index = i + 1;
        const result = await claimReward(accounts[i]);
        if (result.includes('❌')) {
            allSuccessOrRepeat = false;
        }
        summary.push(result);
        if (i < accounts.length - 1) await $.wait(2000);
    }
    const finalTitle = `心悦俱乐部每日任务 (${new Date().toLocaleDateString()})`;
    const finalMessage = summary.join('\n');
    const notifySuccess = $.getdata(KEY_NOTIFY_SUCCESS) !== 'false';
    if (allSuccessOrRepeat && !notifySuccess) {
        $.log('✅ 所有任务执行成功或重复，根据设置不发送通知。');
    } else {
        $.msg($.name, finalTitle, finalMessage);
    }
}

function claimReward(accountData) {
    return new Promise(resolve => {
        const { token, openid, body, nickname, headers } = accountData;
        if (!headers) return resolve(`👤 账号 ${$.index} [${nickname}]: ❌ 缺少 Headers 配置，请重新抓取。`);
        
        const dynamicHeaders = { ...headers }; 
        dynamicHeaders['T-ACCESS-TOKEN'] = token;
        dynamicHeaders['T-OPENID'] = openid;
        delete dynamicHeaders['Content-Length']; 

        const requestOptions = {
            url: `https://bgw.xinyue.qq.com/XyCard.CardSrv/ReceiveGift`,
            method: "POST",
            headers: dynamicHeaders,
            body: body
        };

        $.log(`\n▶️ 开始为账号 [${nickname}] (账号 ${$.index}) 领取奖励...`);
        
        $.post(requestOptions, (error, response, data) => {
            const debugLog = $.getdata(KEY_DEBUG_LOG) === 'true';
            if (debugLog) {
                $.log(`[调试日志] 账号 [${nickname}] 原始响应: ${data}`);
            }

            let resultSummary = `👤 账号 ${$.index} [${nickname}]: `;
            try {
                if (error) throw new Error(error);
                const res = JSON.parse(data);
                if (res.ret === 0) {
                    if (res.data && res.data.gift_info && res.data.gift_info.length > 0) {
                        const giftName = res.data.gift_info[0].items[0].name || '未知奖励';
                        const giftCount = res.data.gift_info[0].items[0].quantity || 1;
                        resultSummary += `✅ 领取成功 - 获得了 ${giftName} x${giftCount}`;
                    } else if (res.data && res.data.pop_info && res.data.pop_info.content.includes('今日已领取')) {
                        resultSummary += `🔁 ${res.data.pop_info.content}`;
                    } else {
                        resultSummary += `✅ 操作成功，但未识别到奖励。`;
                    }
                } else {
                    let errorDetail = `❌ 领取失败 - ${res.msg || '未知错误'}`;
                    if (res.ret === 7001 || res.ret === 7002 || (res.msg && res.msg.toLowerCase().includes('token'))) {
                        errorDetail += ` (❗️Token 可能已失效)`;
                    } else if (res.ret === 7006 && res.msg === "tourist mode") {
                        errorDetail += ` (❗️配置参数不匹配)`;
                    }
                    resultSummary += errorDetail;
                }
            } catch (e) {
                resultSummary += '❌ 请求异常或返回数据非JSON';
            }
            resolve(resultSummary);
        });
    });
}

function Env(t,e){class s{constructor(t){this.env=t}send(t,e="GET"){t="string"==typeof t?{url:t}:t;let s=this.get;return"POST"===e&&(s=this.post),new Promise((e,i)=>{s.call(this,t,(t,s,r)=>{t?i(t):e(s)})})}get(t){return this.send.call(this.env,t)}post(t){return this.send.call(this.env,t,"POST")}}return new class{constructor(t,e){this.name=t,this.http=new s(this),this.data=null,this.dataFile="box.dat",this.logs=[],this.isMute=!1,this.isNeedRewrite=!1,this.logSeparator="\n",this.startTime=(new Date).getTime(),Object.assign(this,e),this.log("",`\ud83d\udd14${this.name}, \u5f00\u59cb!`)}isNode(){return"undefined"!=typeof module&&!!module.exports}isQuanX(){return"undefined"!=typeof $task}isSurge(){return"undefined"!=typeof $httpClient&&"undefined"==typeof $loon}isLoon(){return"undefined"!=typeof $loon}toObj(t,e=null){try{return JSON.parse(t)}catch{return e}}toStr(t,e=null){try{return JSON.stringify(t)}catch{return e}}getjson(t,e){let s=e;const i=this.getdata(t);if(i)try{s=JSON.parse(this.getdata(t))}catch{}return s}setjson(t,e){try{return this.setdata(JSON.stringify(t),e)}catch{return!1}}getScript(t){return new Promise(e=>{this.get({url:t},(t,s,i)=>e(i))})}runScript(t,e){return new Promise(s=>{let i=this.getdata("@chavy_boxjs_userCfgs.httpapi");i=i?i.replace(/\n/g,"").trim():i;let r=this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout");r=r?1*r:20,r=e&&e.timeout?e.timeout:r;const[o,h]=i.split("@"),a={url:`http://${h}/v1/scripting/evaluate`,body:{script_text:t,mock_type:"cron",timeout:r},headers:{"X-Key":o,Accept:"*/*"}};this.post(a,(t,e,i)=>s(i))}).catch(t=>this.logErr(t))}loaddata(){if(!this.isNode())return{};{this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e);if(!s&&!i)return{};{const i=s?t:e;try{return JSON.parse(this.fs.readFileSync(i))}catch(t){return{}}}}}writedata(){if(this.isNode()){this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e),r=JSON.stringify(this.data);s?this.fs.writeFileSync(t,r):i?this.fs.writeFileSync(e,r):this.fs.writeFileSync(t,r)}}lodash_get(t,e,s){const i=e.replace(/\[(\d+)\]/g,".$1").split(".");let r=t;for(const t of i)if(r=Object(r)[t],void 0===r)return s;return r}lodash_set(t,e,s){return Object(t)!==t?t:(Array.isArray(e)||(e=e.toString().match(/[^.[\]]+/g)||[]),e.slice(0,-1).reduce((t,s,i)=>Object(t[s])===t[s]?t[s]:t[s]=Math.abs(e[i+1])>>0==+e[i+1]?[]:{},t)[e[e.length-1]]=s,t)}getdata(t){let e=this.getval(t);if(/^@/.test(t)){const[,s,i]=/^@(.*?)\.(.*?)$/.exec(t),r=s?this.getval(s):"";if(r)try{const t=JSON.parse(r);e=t?this.lodash_get(t,i,""):e}catch(t){e=""}}return e}setdata(t,e){let s=!1;if(/^@/.test(e)){const[,i,r]=/^@(.*?)\.(.*?)$/.exec(e),o=this.getval(i),h=i?"null"===o?null:o||"{}":"{}";try{const e=JSON.parse(h);this.lodash_set(e,r,t),s=this.setval(JSON.stringify(e),i)}catch(e){const o={};this.lodash_set(o,r,t),s=this.setval(JSON.stringify(o),i)}}else s=this.setval(t,e);return s}getval(t){return this.isSurge()||this.isLoon()?$persistentStore.read(t):this.isQuanX()?$prefs.valueForKey(t):this.isNode()?(this.data=this.loaddata(),this.data[t]):this.data&&this.data[t]||null}setval(t,e){return this.isSurge()||this.isLoon()?$persistentStore.write(t,e):this.isQuanX()?$prefs.setValueForKey(t,e):this.isNode()?(this.data=this.loaddata(),this.data[e]=t,this.writedata(),!0):this.data&&this.data[e]||null}initGotEnv(t){this.got=this.got?this.got:require("got"),this.cktough=this.cktough?this.cktough:require("tough-cookie"),this.ckjar=this.ckjar?this.ckjar:new this.cktough.CookieJar,t&&(t.headers=t.headers?t.headers:{},void 0===t.headers.Cookie&&void 0===t.cookieJar&&(t.cookieJar=this.ckjar))}get(t,e=(()=>{})){t.headers&&(delete t.headers["Content-Type"],delete t.headers["Content-Length"]),this.isSurge()||this.isLoon()?(this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient.get(t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status),e(t,s,i)})):this.isQuanX()?(this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>e(t))):this.isNode()&&(this.initGotEnv(t),this.got(t).on("redirect",(t,e)=>{try{if(t.headers["set-cookie"]){const s=t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString();this.ckjar.setCookieSync(s,null),e.cookieJar=this.ckjar}}catch(t){this.logErr(t)}}).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>{const{message:s,response:i}=t;e(s,i,i&&i.body)}))}post(t,e=(()=>{})){if(t.body&&t.headers&&!t.headers["Content-Type"]&&(t.headers["Content-Type"]="application/x-www-form-urlencoded"),t.headers&&delete t.headers["Content-Length"],this.isSurge()||this.isLoon())this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient.post(t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status),e(t,s,i)});else if(this.isQuanX())t.method="POST",this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>e(t));else if(this.isNode()){this.initGotEnv(t);const{url:s,...i}=t;this.got.post(s,i).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>{const{message:s,response:i}=t;e(s,i,i&&i.body)})}}time(t){let e={"M+":(new Date).getMonth()+1,"d+":(new Date).getDate(),"H+":(new Date).getHours(),"m+":(new Date).getMinutes(),"s+":(new Date).getSeconds(),"q+":Math.floor(((new Date).getMonth()+3)/3),S:(new Date).getMilliseconds()};/(y+)/.test(t)&&(t=t.replace(RegExp.$1,((new Date).getFullYear()+"").substr(4-RegExp.$1.length)));for(let s in e)new RegExp("("+s+")").test(t)&&(t=t.replace(RegExp.$1,1==RegExp.$1.length?e[s]:("00"+e[s]).substr((""+e[s]).length)));return t}msg(e=t,s="",i="",r){const o=t=>{if(!t)return t;if("string"==typeof t)return this.isLoon()?t:this.isQuanX()?{"open-url":t}:this.isSurge()?{url:t}:void 0;if("object"==typeof t){if(this.isLoon()){let e=t.openUrl||t.url||t["open-url"],s=t.mediaUrl||t["media-url"];return{openUrl:e,mediaUrl:s}}if(this.isQuanX()){let e=t["open-url"]||t.url||t.openUrl,s=t["media-url"]||t.mediaUrl;return{"open-url":e,"media-url":s}}if(this.isSurge()){let e=t.url||t.openUrl||t["open-url"];return{url:e}}}};this.isMute||(this.isSurge()||this.isLoon()?$notification.post(e,s,i,o(r)):this.isQuanX()&&$notify(e,s,i,o(r)));let h=["","==============\ud83d\udce3\u7cfb\u7edf\u901a\u77e5\ud83d\udce3=============="];h.push(e),s&&h.push(s),i&&h.push(i),console.log(h.join("\n")),this.logs=this.logs.concat(h)}log(...t){t.length>0&&(this.logs=[...this.logs,...t]),console.log(t.join(this.logSeparator))}logErr(t,e){const s=!this.isSurge()&&!this.isQuanX()&&!this.isLoon();s?this.log("",`\u2757\ufe0f${this.name}, \u9519\u8bef!`,t.stack):this.log("",`\u2757\ufe0f${this.name}, \u9519\u8bef!`,t)}wait(t){return new Promise(e=>setTimeout(e,t))}done(t={}){const e=(new Date).getTime(),s=(e-this.startTime)/1e3;this.log("",`\ud83d\udd14${this.name}, \u7ed3\u675f! \ud83d\udd5b ${s} \u79d2`),this.log(),(this.isSurge()||this.isQuanX()||this.isLoon())&&$done(t)}}(t,e)}
