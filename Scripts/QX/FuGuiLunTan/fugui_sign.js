/*
 * 富贵论坛每日签到脚本
 *
 * 作者: TimeJason (由 Gemini 辅助生成)
 * 更新日期: 2025-08-10
 *
 * 功能:
 *   - 监听签到请求，自动抓取并保存账号配置（完整的 Headers）。
 *   - 定时任务自动执行签到，并对成功/失败/重复状态进行美化通知。
 *   - 兼容 Quantumult X, 并可通过 BoxJs 进行管理。
 */

const $ = new Env('富贵论坛');

// --- BoxJs Keys ---
const FUGUI_DATA_KEY = 'fugui_datas';
const KEY_NOTIFY_SUCCESS = 'fugui_notify_success';
const KEY_DEBUG_LOG = 'fugui_debug_log';

// 判断脚本运行环境
if (typeof $request !== 'undefined' && $request.url.includes('api.fglt.net/my/checkin')) {
    $.log('进入数据获取模式...');
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

/**
 * 抓取并保存用户凭证
 */
function getAuthData() {
    if (!$request.headers) {
        return $.msg($.name, '❌ 获取失败', '未能读取到请求头 (Headers)。');
    }
    
    try {
        const headers = $request.headers;
        const authorization = headers['authorization'] || headers['Authorization'];
        const clientId = headers['client-id'];

        if (!authorization) {
            return $.msg($.name, '❌ 获取失败', '未能从请求头中找到 [authorization] 凭证！');
        }
        if (!clientId) {
            return $.msg($.name, '❌ 获取失败', '未能从请求头中找到 [client-id]！建议更新 App 后再试。');
        }

        const nickname = `用户_${clientId.slice(-6)}`;
        const newAccountData = {
            clientId: clientId,
            nickname: nickname,
            headers: headers
        };

        let accounts = $.getdata(FUGUI_DATA_KEY) ? JSON.parse($.getdata(FUGUI_DATA_KEY)) : [];
        const accountIndex = accounts.findIndex(acc => acc.clientId === clientId);

        if (accountIndex > -1) {
            accounts[accountIndex].headers = newAccountData.headers; // 只更新headers，保留用户可能修改过的昵称
            $.msg($.name, `✅ 配置更新成功`, `账号: [${accounts[accountIndex].nickname}]\n已更新为最新的有效配置。`);
        } else {
            accounts.push(newAccountData);
            $.msg($.name, `✅ 配置添加成功`, `账号: [${nickname}]\n已完成初始化，你可以在 BoxJs 中为它设置一个易于辨识的昵称。`);
        }
        
        $.setdata(JSON.stringify(accounts), FUGUI_DATA_KEY);

    } catch (e) {
        $.msg($.name, '❌ 获取失败', `处理数据时发生异常: ${e.message}`);
        $.logErr(e);
    }
}

/**
 * 执行所有账号的签到任务
 */
async function runTasks() {
    const accountsStr = $.getdata(FUGUI_DATA_KEY);
    if (!accountsStr) {
        return $.msg($.name, '❌ 未找到配置', '请先在富贵论坛 App 内手动“签到”一次以初始化脚本。');
    }

    const accounts = JSON.parse(accountsStr);
    if (accounts.length === 0) {
        return $.msg($.name, '🤔 配置为空', '没有找到任何账号信息，请先抓取数据。');
    }

    $.log(`共发现 ${accounts.length} 个账号，开始执行签到任务...`);
    const summary = [];
    let allSuccessOrRepeat = true;

    for (let i = 0; i < accounts.length; i++) {
        $.index = i + 1;
        const result = await claimReward(accounts[i]);
        if (result.includes('❌')) {
            allSuccessOrRepeat = false;
        }
        summary.push(result);
        if (i < accounts.length - 1) await $.wait(1500); // 避免请求过于频繁
    }

    const finalTitle = `富贵论坛签到速报 (${new Date().toLocaleDateString()})`;
    const finalMessage = summary.join('\n');
    const notifySuccess = $.getdata(KEY_NOTIFY_SUCCESS) !== 'false';

    if (allSuccessOrRepeat && !notifySuccess) {
        $.log('✅ 所有任务执行成功或重复，根据设置不发送通知。');
    } else {
        $.msg($.name, finalTitle, finalMessage);
    }
}

/**
 * 为单个账号执行签到
 * @param {object} accountData 账号数据
 */
function claimReward(accountData) {
    return new Promise(resolve => {
        const { nickname, headers } = accountData;
        
        if (!headers || !headers.authorization) {
            return resolve(`👤 账号 ${$.index} [${nickname}]: ❌ 缺少 Headers 或 authorization 配置，请重新抓取。`);
        }
        
        const dynamicHeaders = { ...headers };
        delete dynamicHeaders['Content-Length'];
        delete dynamicHeaders['content-length'];
        delete dynamicHeaders['host'];

        const requestOptions = {
            url: `https://api.fglt.net/my/checkin`,
            method: "POST",
            headers: dynamicHeaders,
            body: ``
        };

        $.log(`\n▶️ 开始为账号 [${nickname}] (账号 ${$.index}) 进行签到...`);
        
        $.post(requestOptions, (error, response, data) => {
            const debugLog = $.getdata(KEY_DEBUG_LOG) === 'true';
            if (debugLog) {
                $.log(`[调试日志] 账号 [${nickname}] - 状态码: ${response.status} - 原始响应: ${data}`);
            }

            let resultSummary = `👤 账号 ${$.index} [${nickname}]: `;
            try {
                if (error) throw new Error(error);
                
                const res = JSON.parse(data);
                
                if (res.code === 0 && res.message && res.message.includes('成功')) {
                    const gained = res.data ? `获得 ${res.data.gained || '奖励'}` : `操作成功`;
                    resultSummary += `✅ 签到成功 - ${gained}`;
                } else if (res.message && res.message.includes('已经签到')) {
                    resultSummary += `🔁 ${res.message}`;
                } else {
                    const errorDetail = res.message || '未知错误';
                    resultSummary += `❌ 签到失败 - ${errorDetail}`;
                    if (errorDetail.includes('Token') || errorDetail.includes('登录')) {
                         resultSummary += ` (❗️Token 可能已失效，请重新抓取)`;
                    }
                }
            } catch (e) {
                resultSummary += '❌ 请求异常或响应非 JSON。请检查网络或开启调试日志查看详情。';
                $.logErr(e);
            }
            resolve(resultSummary);
        });
    });
}

// Env.js 兼容层
function Env(t,e){class s{constructor(t){this.env=t}send(t,e="GET"){t="string"==typeof t?{url:t}:t;let s=this.get;return"POST"===e&&(s=this.post),new Promise((e,i)=>{s.call(this,t,(t,s,r)=>{t?i(t):e(s)})})}get(t){return this.send.call(this.env,t)}post(t){return this.send.call(this.env,t,"POST")}}return new class{constructor(t,e){this.name=t,this.http=new s(this),this.data=null,this.dataFile="box.dat",this.logs=[],this.isMute=!1,this.isNeedRewrite=!1,this.logSeparator="\n",this.startTime=(new Date).getTime(),Object.assign(this,e),this.log("",`\ud83d\udd14${this.name}, \u5f00\u59cb!`)}isNode(){return"undefined"!=typeof module&&!!module.exports}isQuanX(){return"undefined"!=typeof $task}isSurge(){return"undefined"!=typeof $httpClient&&"undefined"==typeof $loon}isLoon(){return"undefined"!=typeof $loon}toObj(t,e=null){try{return JSON.parse(t)}catch{return e}}toStr(t,e=null){try{return JSON.stringify(t)}catch{return e}}getjson(t,e){let s=e;const i=this.getdata(t);if(i)try{s=JSON.parse(this.getdata(t))}catch{}return s}setjson(t,e){try{return this.setdata(JSON.stringify(t),e)}catch{return!1}}getScript(t){return new Promise(e=>{this.get({url:t},(t,s,i)=>e(i))})}runScript(t,e){return new Promise(s=>{let i=this.getdata("@chavy_boxjs_userCfgs.httpapi");i=i?i.replace(/\n/g,"").trim():i;let r=this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout");r=r?1*r:20,r=e&&e.timeout?e.timeout:r;const[o,h]=i.split("@"),a={url:`http://${h}/v1/scripting/evaluate`,body:{script_text:t,mock_type:"cron",timeout:r},headers:{"X-Key":o,Accept:"*/*"}};this.post(a,(t,e,i)=>s(i))}).catch(t=>this.logErr(t))}loaddata(){if(!this.isNode())return{};{this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e);if(!s&&!i)return{};{const i=s?t:e;try{return JSON.parse(this.fs.readFileSync(i))}catch(t){return{}}}}}writedata(){if(this.isNode()){this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e),r=JSON.stringify(this.data);s?this.fs.writeFileSync(t,r):i?this.fs.writeFileSync(e,r):this.fs.writeFileSync(t,r)}}lodash_get(t,e,s){const i=e.replace(/\[(\d+)\]/g,".$1").split(".");let r=t;for(const t of i)if(r=Object(r)[t],void 0===r)return s;return r}lodash_set(t,e,s){return Object(t)!==t?t:(Array.isArray(e)||(e=e.toString().match(/[^.[\]]+/g)||[]),e.slice(0,-1).reduce((t,s,i)=>Object(t[s])===t[s]?t[s]:t[s]=Math.abs(e[i+1])>>0==+e[i+1]?[]:{},t)[e[e.length-1]]=s,t)}getdata(t){let e=this.getval(t);if(/^@/.test(t)){const[,s,i]=/^@(.*?)\.(.*?)$/.exec(t),r=s?this.getval(s):"";if(r)try{const t=JSON.parse(r);e=t?this.lodash_get(t,i,""):e}catch(t){e=""}}return e}setdata(t,e){let s=!1;if(/^@/.test(e)){const[,i,r]=/^@(.*?)\.(.*?)$/.exec(e),o=this.getval(i),h=i?"null"===o?null:o||"{}":"{}";try{const e=JSON.parse(h);this.lodash_set(e,r,t),s=this.setval(JSON.stringify(e),i)}catch(e){const o={};this.lodash_set(o,r,t),s=this.setval(JSON.stringify(o),i)}}else s=this.setval(t,e);return s}getval(t){return this.isSurge()||this.isLoon()?$persistentStore.read(t):this.isQuanX()?$prefs.valueForKey(t):this.isNode()?(this.data=this.loaddata(),this.data[t]):this.data&&this.data[t]||null}setval(t,e){return this.isSurge()||this.isLoon()?$persistentStore.write(t,e):this.isQuanX()?$prefs.setValueForKey(t,e):this.isNode()?(this.data=this.loaddata(),this.data[e]=t,this.writedata(),!0):this.data&&this.data[e]||null}initGotEnv(t){this.got=this.got?this.got:require("got"),this.cktough=this.cktough?this.cktough:require("tough-cookie"),this.ckjar=this.ckjar?this.ckjar:new this.cktough.CookieJar,t&&(t.headers=t.headers?t.headers:{},void 0===t.headers.Cookie&&void 0===t.cookieJar&&(t.cookieJar=this.ckjar))}get(t,e=(()=>{})){t.headers&&(delete t.headers["Content-Type"],delete t.headers["Content-Length"]),this.isSurge()||this.isLoon()?(this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient.get(t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status),e(t,s,i)})):this.isQuanX()?(this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>e(t))):this.isNode()&&(this.initGotEnv(t),this.got(t).on("redirect",(t,e)=>{try{if(t.headers["set-cookie"]){const s=t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString();this.ckjar.setCookieSync(s,null),e.cookieJar=this.ckjar}}catch(t){this.logErr(t)}}).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>{const{message:s,response:i}=t;e(s,i,i&&i.body)}))}post(t,e=(()=>{})){if(t.body&&t.headers&&!t.headers["Content-Type"]&&(t.headers["Content-Type"]="application/x-www-form-urlencoded"),t.headers&&delete t.headers["Content-Length"],this.isSurge()||this.isLoon())this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient.post(t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status),e(t,s,i)});else if(this.isQuanX())t.method="POST",this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>e(t));else if(this.isNode()){this.initGotEnv(t);const{url:s,...i}=t;this.got.post(s,i).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>{const{message:s,response:i}=t;e(s,i,i&&i.body)})}}time(t){let e={"M+":(new Date).getMonth()+1,"d+":(new Date).getDate(),"H+":(new Date).getHours(),"m+":(new Date).getMinutes(),"s+":(new Date).getSeconds(),"q+":Math.floor(((new Date).getMonth()+3)/3),S:(new Date).getMilliseconds()};/(y+)/.test(t)&&(t=t.replace(RegExp.$1,((new Date).getFullYear()+"").substr(4-RegExp.$1.length)));for(let s in e)new RegExp("("+s+")").test(t)&&(t=t.replace(RegExp.$1,1==RegExp.$1.length?e[s]:("00"+e[s]).substr((""+e[s]).length)));return t}msg(e=t,s="",i="",r){const o=t=>{if(!t)return t;if("string"==typeof t)return this.isLoon()?t:this.isQuanX()?{"open-url":t}:this.isSurge()?{url:t}:void 0;if("object"==typeof t){if(this.isLoon()){let e=t.openUrl||t.url||t["open-url"],s=t.mediaUrl||t["media-url"];return{openUrl:e,mediaUrl:s}}if(this.isQuanX()){let e=t["open-url"]||t.url||t.openUrl,s=t["media-url"]||t.mediaUrl;return{"open-url":e,"media-url":s}}if(this.isSurge()){let e=t.url||t.openUrl||t["open-url"];return{url:e}}}};this.isMute||(this.isSurge()||this.isLoon()?$notification.post(e,s,i,o(r)):this.isQuanX()&&$notify(e,s,i,o(r)));let h=["","==============\ud83d\udce3\u7cfb\u7edf\u901a\u77e5\ud83d\udce3=============="];h.push(e),s&&h.push(s),i&&h.push(i),console.log(h.join("\n")),this.logs=this.logs.concat(h)}log(...t){t.length>0&&(this.logs=[...this.logs,...t]),console.log(t.join(this.logSeparator))}logErr(t,e){const s=!this.isSurge()&&!this.isQuanX()&&!this.isLoon();s?this.log("",`\u2757\ufe0f${this.name}, \u9519\u8bef!`,t.stack):this.log("",`\u2757\ufe0f${this.name}, \u9519\u8bef!`,t)}wait(t){return new Promise(e=>setTimeout(e,t))}done(t={}){const e=(new Date).getTime(),s=(e-this.startTime)/1e3;this.log("",`\ud83d\udd14${this.name}, \u7ed3\u675f! \ud83d\udd5b ${s} \u79d2`),this.log(),(this.isSurge()||this.isQuanX()||this.isLoon())&&$done(t)}}(t,e)}
