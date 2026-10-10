/*
 * 心悦俱乐部悦享卡每日奖励自动领取脚本 v9.7 (免点击版)
 *
 * 作者: TimeJason
 * 更新日期: 2026-10-10
 *
 * 核心思路:
 *   抓取并保存一次完整的领奖参数 (token + headers + 重建的 body), 之后定时重放。
 *
 * 免点击抓取:
 *   打开「我的卡」页面即自动抓取, 不需要手动点"领取"。挂了 3 个接口:
 *     - MyCardList  : 打开「我的卡」时发。响应里 my_user_info 直接列出你持有的卡,
 *                     含 card_id / role / record_id -> 「免点击 + 自动识别」的首选。
 *     - GetCardInfo : 已开通卡详情页, 请求带 record_id。
 *     - ReceiveGift : 点击"领取"时发。最精确, 含 user_info。
 *   判定规则: record_id 非空的来源才算"已开通的卡", 据此自动选中你持有的那张。
 *   注: 卡片的"购买页"接口 GetCardBuyStatus 不挂钩子 —— 它 98/198 都发且
 *       record_id 恒为空, 抓到的参数缺字段领不了奖, 只会产生噪音。
 *
 * 相比 v9.6:
 *   - 日志分工: 过程逐步展示 (📡 查卡 -> 🎫 卡片详情 -> 🎁 领取 -> 结果),
 *     汇总区改为每账号单行摘要, 多行富信息块只进系统通知, 不再重复
 */

const $ = new Env('心悦俱乐部');
const notify = $.isNode() ? require('./sendNotify') : '';

// --- BoxJs Keys ---
const XINYUE_DATA_KEY = 'xinyue_datas';
const KEY_NOTIFY_SUCCESS = 'xinyue_notify_success';
const KEY_DEBUG_LOG = 'xinyue_debug_log';
const KEY_RENEW_WARN = 'xinyue_renew_warn_days';   // 临期提醒阈值(天), 默认 7

// --- 接口 ---
const HOOK_RECEIVE = '/XyCard.CardSrv/ReceiveGift';       // 点击领取, 精确抓取
const HOOK_GETCARD = '/XyCard.CardSrv/GetCardInfo';       // 已开通卡详情, 含 record_id
const HOOK_MYCARD = '/XyCard.CardSrv/MyCardList';         // 「我的卡」列表, 响应即包含持有的卡
// 需要请求体的钩子
const HOOKS = [HOOK_GETCARD, HOOK_RECEIVE];
// 需要响应体的钩子 (打开「我的卡」页面即触发, 免点击的首选来源)
const HOOKS_RES = [HOOK_MYCARD];
const CLAIM_URL = 'https://bgw.xinyue.qq.com/XyCard.CardSrv/ReceiveGift';
const MYCARD_URL = 'https://bgw.xinyue.qq.com/XyCard.CardSrv/MyCardList';

// 数据来源优先级: MyCardList > ReceiveGift > GetCardInfo
//   MyCardList  : 打开「我的卡」即发, 响应直接给出你持有的卡(含 record_id) -> 最权威
//   ReceiveGift : 真实领奖包, 含 user_info
//   GetCardInfo : 已开通卡详情页, 请求带 record_id
// 注: 卡片的"购买页"接口 GetCardBuyStatus 不挂钩子 —— 它 98/198 都发且 record_id 恒为空,
//     抓到的参数缺字段、领不了奖, 只会产生噪音。
const SOURCE_ORDER = ['mycardlist', 'receive', 'getcard'];
const SOURCE_LABEL = {
    mycardlist: '免点击抓取 (MyCardList 我的卡)',
    receive: '精确抓取 (ReceiveGift)',
    getcard: '免点击抓取 (GetCardInfo)'
};

// 调试模式下收集各账号的原始响应, 统一放到日志最后输出, 不插在结果中间
const rawResponses = [];

if (typeof $request !== 'undefined') {
    if (typeof $response !== 'undefined') {
        // 响应体模式 (script-response-body): 「我的卡」列表。无论抓取是否成功都要原样放行,
        // 否则会把 App 的响应吞掉导致页面异常。
        try {
            if ($request.url && HOOKS_RES.some((u) => $request.url.includes(u)) && $response.body) {
                captureFromMyCardList();
            }
        } catch (e) {
            $.logErr(e);
        }
        $.done({ body: $response.body });
    } else {
        // 请求体模式 (script-request-body)
        if ($request.url && HOOKS.some((u) => $request.url.includes(u))) {
            captureCredentials();
        }
        $.done();
    }
} else {
    // 定时任务模式
    (async () => {
        $.log('进入定时任务模式...');
        await runTasks();
    })().catch((e) => $.logErr(e)).finally(() => finishCron());
}

// 定时任务收尾: 先出"结束", 再统一输出原始响应, 避免大段 JSON 夹在结果中间
function finishCron() {
    const sec = ((Date.now() - $.startTime) / 1000).toFixed(3);
    $.log('', `🔔${$.name}, 结束! 🕛 ${sec} 秒`);
    if (rawResponses.length) {
        $.log();
        $.log('──────────── 原始响应 (调试) ────────────');
        rawResponses.forEach((line) => $.log('  ' + line));
    }
    $.log();
    $done({});
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

    const sourceKey = $request.url.includes(HOOK_RECEIVE) ? 'receive' : 'getcard';

    saveCapture({ openid, token, headers, sourceKey, sources: { [sourceKey]: body } });
}

// 从 MyCardList 响应里解析持有的卡及其展示信息 (价格/到期/进度)。
// 返回 { owned, cardInfo } 或 null。cardInfo 供通知展示, 不参与领奖 body。
function parseMyCardList(res) {
    if (!res || res.ret !== 0 || !res.data) return null;
    const ownedList = Array.isArray(res.data.my_user_info) ? res.data.my_user_info : [];
    // 只认真正开通的卡: record_id 非空。已过期卡在 expire_user_info 里, 不取。
    const owned = ownedList.find((u) => u.record_id && u.card_id && u.role) || null;
    if (!owned) return { owned: null, cardInfo: null };

    const cfgKey = `${owned.gid}:${owned.card_type}:${owned.card_id}`;
    const cfg = res.data.cards && res.data.cards[cfgKey] && res.data.cards[cfgKey].base_info
        ? res.data.cards[cfgKey].base_info : null;
    const month = owned.month && owned.month.base_info ? owned.month.base_info : null;

    const cardInfo = {
        title: (cfg && cfg.card_title) || '悦享卡',
        price: cfg && cfg.guide_price ? Math.round(cfg.guide_price / 100) : null,
        start_time: month ? month.start_time : null,
        end_time: month ? month.end_time : null,
        gift_got_num: month ? month.gift_got_num : null,
        gift_total_num: month ? month.gift_total_num : null,
        checkedAt: Date.now()
    };
    return { owned, cardInfo };
}

// 卡片显示名: 有价格用 "198悦享卡"; 没有则退回 card_id (如 yxk981, 价格未知)
function cardLabel(cardInfo, cardId) {
    if (cardInfo && cardInfo.price) return `${cardInfo.price}${cardInfo.title || '悦享卡'}`;
    return cardId || '悦享卡';
}

// 秒级时间戳 -> "MM-dd"
function fmtDate(sec) {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 距到期还剩几个自然日 (当天到期 = 0)
function daysLeft(sec) {
    if (!sec) return null;
    const e = new Date(sec * 1000), n = new Date();
    const e0 = new Date(e.getFullYear(), e.getMonth(), e.getDate());
    const n0 = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    return Math.round((e0 - n0) / 86400000);
}

// 「我的卡」列表: 请求体不含卡, 但响应里的 my_user_info 直接给出你持有的卡
// (含 card_id / role / record_id), 是"免点击 + 自动识别持有哪张卡"的首选来源。
function captureFromMyCardList() {
    const headers = $request.headers || {};
    const token = headers['T-ACCESS-TOKEN'] || headers['t-access-token'];
    const openid = headers['T-OPENID'] || headers['t-openid'];
    if (!token || !openid) return;

    let res;
    try { res = JSON.parse($response.body); } catch (e) { return; }
    const parsed = parseMyCardList(res);
    if (!parsed) return;
    if (!parsed.owned) return $.log('「我的卡」里没有已开通的卡, 已跳过。');
    const card = parsed.owned;

    // channel/pay_channel 不在响应体里, 但「我的卡」的请求体带着, 取真实值而非写死
    let reqBody = {};
    try { reqBody = JSON.parse($request.body || '{}'); } catch (e) {}

    saveCapture({
        openid,
        token,
        headers,
        sourceKey: 'mycardlist',
        cardInfo: parsed.cardInfo,
        sources: {
            mycardlist: {
                gid: card.gid,
                card_group: card.card_group,
                card_type: card.card_type,
                card_id: card.card_id,
                channel: reqBody.channel || 'vip',
                pay_channel: reqBody.pay_channel || 'iap',
                role: card.role,
                record_id: card.record_id
            }
        }
    });
}

// 把某个来源抓到的数据并入配置, 并弹出结果通知
function saveCapture({ openid, token, headers, sources: incoming, sourceKey, cardInfo }) {
    let accounts = $.toObj($.getdata(XINYUE_DATA_KEY), []);
    if (!Array.isArray(accounts)) accounts = [];
    const idx = accounts.findIndex((a) => a.openid === openid);
    const prev = idx > -1 ? accounts[idx] : {};

    const account = buildAccountRecord(prev, { openid, token, headers, sources: incoming, cardInfo });

    if (idx > -1) {
        accounts[idx] = account;
    } else {
        accounts.push(account);
    }

    const label = SOURCE_LABEL[sourceKey];
    const card = cardLabel(account.cardInfo, account.card_id);
    if (account.owned) {
        const expiry = account.cardInfo && account.cardInfo.end_time
            ? ` · ${fmtDate(account.cardInfo.end_time)} 到期` : '';
        $.msg($.name, idx > -1 ? '✅ 配置已更新' : '✅ 配置已添加',
            `账号: [${account.displayName}]\n来源: ${label}\n卡片: ${card} (已开通${expiry})`);
    } else {
        $.msg($.name, '⚠️ 未识别到已开通的卡',
            `账号: [${account.displayName}]\n卡片: ${card}\n请打开「我的卡」页面重新抓取。`);
    }
    $.setdata(JSON.stringify(accounts), XINYUE_DATA_KEY);
    $.log(`当前共 ${accounts.length} 个账号。`);
}

// 由历史记录 + 新数据构建账号存储结构。抓取与"续费自愈"共用。
function buildAccountRecord(prev, { openid, token, headers, sources: incoming, cardInfo }) {
    // 按来源分别保存原始包, 读取时按优先级解析, 避免低优先级覆盖高优先级
    const sources = { ...(prev.sources || {}), ...incoming };

    const resolved = resolveSources(sources);

    // user_info: ReceiveGift 自带, 否则复用历史缓存
    let userInfo = prev.user_info || null;
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
    // 昵称: 原样保留抓到的值(有人昵称就是全角空格这类不可见字符, 请求里要原样带回)。
    // displayName 只用于通知显示 —— 若昵称全是空白, 退回角色名, 免得通知里显示成空的。
    const nickname = (userInfo && typeof userInfo.nickname === 'string') ? userInfo.nickname : '';
    const displayName = nickname.trim() || roleName || `用户_${openid.slice(0, 6)}`;

    return {
        token,
        openid,
        nickname,
        displayName,
        roleName,
        sources,
        card_id: resolved.card_id || '',
        record_id: resolved.record_id || '',
        owned: resolved.owned,
        headers,
        user_info: userInfo,
        claimBody,
        cardInfo: cardInfo || prev.cardInfo || null,
        updatedAt: new Date().toISOString()
    };
}

// 从各来源中挑出要领取的卡。
// 判定依据是 record_id: 只有真正开通的卡, 接口才会带上它。
//   - MyCardList       : 打开「我的卡」即发, 响应列出持有的卡(含 record_id) -> 最权威
//   - ReceiveGift      : 真实领奖包, 带 record_id 和最全的 user_info
//   - GetCardInfo      : 已开通卡详情页, 请求带 record_id
//   - GetCardBuyStatus : 购买资格查询, 98/198 都发, record_id 恒为空 -> 不能用来判断持有哪张
// 因此: 先找 record_id 非空的来源锁定持有的卡; 都没有则退化为草稿(不可用于领取)。
function resolveSources(sources) {
    const byRank = SOURCE_ORDER.map((k) => sources[k]).filter(Boolean);
    const owned = byRank.find((b) => b.record_id);
    const card = owned || byRank.find((b) => b.card_id) || {};
    const roleSrc = (owned && owned.role && owned.role.role_id ? owned : null)
        || byRank.find((b) => b.role && b.role.role_id) || {};
    return {
        gid: card.gid,
        card_group: card.card_group,
        card_type: card.card_type,
        card_id: card.card_id,
        channel: card.channel,
        pay_channel: card.pay_channel,
        role: roleSrc.role,
        record_id: owned ? owned.record_id : '',
        owned: !!owned
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

// 领取前实时查询「我的卡」(只读)。拿到: 当前持有的卡(含最新 record_id)、
// 价格/到期日/已领进度。返回:
//   { status: 'ok', owned, cardInfo }  查询成功
//   { status: 'nocard' }               查询成功但没有有效卡 (已过期/未开通)
//   { status: 'fail' }                 查询失败, 调用方退回本地缓存
function queryCardStatus(acc) {
    return new Promise((resolve) => {
        if (!acc.headers) return resolve({ status: 'fail' });
        const headers = { ...acc.headers };
        headers['T-ACCESS-TOKEN'] = acc.token;
        headers['T-OPENID'] = acc.openid;
        delete headers['Content-Length'];

        // MyCardList 的请求体不含任何卡信息, channel/pay_channel 用存的真值
        const src = (acc.sources && acc.sources.mycardlist) || {};
        const body = JSON.stringify({
            channel: src.channel || 'vip',
            pay_channel: src.pay_channel || 'iap',
            device: 'ios',
            platform: 'tgclubApp'
        });

        $.post({ url: MYCARD_URL, method: 'POST', headers, body }, (error, response, data) => {
            if (error) return resolve({ status: 'fail' });
            try {
                const res = JSON.parse(data);
                const parsed = parseMyCardList(res);
                if (!parsed || !parsed.owned) return resolve({ status: 'nocard' });
                resolve({ status: 'ok', owned: parsed.owned, cardInfo: parsed.cardInfo });
            } catch (e) {
                resolve({ status: 'fail' });
            }
        });
    });
}

// 实时查到的卡并回本地配置 (静默, 不发通知)。
// 续费后 record_id 会变 —— 这里自动重建领奖 body, 用户无需重新抓取。
function applyLiveCard(acc, { owned, cardInfo }) {
    let accounts = $.toObj($.getdata(XINYUE_DATA_KEY), []);
    if (!Array.isArray(accounts)) accounts = [];
    const idx = accounts.findIndex((a) => a.openid === acc.openid);
    const prev = idx > -1 ? accounts[idx] : acc;

    const oldSrc = (prev.sources && prev.sources.mycardlist) || {};
    const updated = buildAccountRecord(prev, {
        openid: acc.openid,
        token: acc.token,
        headers: acc.headers,
        cardInfo,
        sources: {
            mycardlist: {
                gid: owned.gid,
                card_group: owned.card_group,
                card_type: owned.card_type,
                card_id: owned.card_id,
                channel: oldSrc.channel || 'vip',
                pay_channel: oldSrc.pay_channel || 'iap',
                role: owned.role,
                record_id: owned.record_id
            }
        }
    });
    // T-GID 随卡走, 防止换卡后请求头还带着旧 gid
    if (owned.gid && updated.headers) updated.headers['T-GID'] = String(owned.gid);

    if (idx > -1) accounts[idx] = updated; else accounts.push(updated);
    $.setdata(JSON.stringify(accounts), XINYUE_DATA_KEY);

    if (updated.record_id && updated.record_id !== prev.record_id) {
        const oldTail = prev.record_id ? `...${String(prev.record_id).slice(-4)}` : '无';
        $.log(`  🔁 检测到新一期卡片 (record_id ${oldTail} -> ...${String(updated.record_id).slice(-4)}), 领奖参数已自动重建`);
    }
    return updated;
}

// 单账号完整流程: 实时查卡 -> (自愈/过期判断) -> 领取 -> 组装富信息结果块
// 日志里逐步展示过程 (查到什么/变没变/领得如何), 富信息块留给系统通知
async function processAccount(acc) {
    const name = acc.displayName || acc.nickname || acc.openid;
    $.log(`\n▶️ [${name}]`);
    $.log('  📡 查询「我的卡」最新状态...');

    const live = await queryCardStatus(acc);

    let claimAcc = acc;
    let cardInfo = acc.cardInfo || null;

    if (live.status === 'nocard') {
        // 卡已过期或未开通: 不再盲发领奖请求
        $.log('  ❌ 服务器确认: 当前没有有效悦享卡 (已过期/未开通), 跳过领取');
        const until = cardInfo && cardInfo.end_time ? ` (${fmtDate(cardInfo.end_time)} 到期)` : '';
        return [
            `👤 [${name}] ❌ 未查询到有效悦享卡${until}, 今日未领取`,
            `💡 App 内续费后, 明早自动恢复领取 (无需重新配置)`
        ];
    }
    if (live.status === 'ok') {
        claimAcc = applyLiveCard(acc, live);
        cardInfo = live.cardInfo;
        const ci = live.cardInfo;
        const period = ci.start_time ? `本期 ${fmtDate(ci.start_time)} ~ ${fmtDate(ci.end_time)}` : `至 ${fmtDate(ci.end_time)} 到期`;
        const prog = ci.gift_total_num ? `已领 ${ci.gift_got_num}/${ci.gift_total_num} 天` : '';
        $.log(`  🎫 ${cardLabel(ci, null)} · ${period}${prog ? ' · ' + prog : ''} · record_id ...${String(claimAcc.record_id).slice(-4)}`);
    } else {
        $.log('  ⚠️ 实时查询失败, 使用本地缓存信息继续');
    }

    $.log('  🎁 发起领取请求...');
    const claimLine = await claimReward(claimAcc);
    const block = buildAccountBlock(name, claimLine, cardInfo);
    $.log('  ' + block[1]);
    const warnLine = block.find((l) => /^(‼️|❗️|⏰)/.test(l));
    if (warnLine) $.log('  ' + warnLine);
    return block;
}

// 把领取结果 + 卡片状态组装成多行展示块
function buildAccountBlock(name, claimLine, cardInfo) {
    const result = claimLine.replace(/^👤\s*\[[^\]]*\]:\s*/, '');
    if (!cardInfo || !cardInfo.end_time) return [`👤 [${name}]`, result];

    const label = cardLabel(cardInfo, null);
    const d = daysLeft(cardInfo.end_time);
    const until = fmtDate(cardInfo.end_time);
    const block = [`👤 [${name}] 🎫 ${label}`, result];

    if (cardInfo.gift_total_num) {
        // 查询发生在领取前: 今天领取成功则已领数 +1; "今日已领取"说明 App 里领过, 不加
        const delta = result.includes('✅') && !result.includes('无可领') ? 1 : 0;
        const got = Math.min((cardInfo.gift_got_num || 0) + delta, cardInfo.gift_total_num);
        block.push(`📊 本期已领 ${got}/${cardInfo.gift_total_num} 天 · 剩 ${d} 天 (${until} 到期)`);
    } else {
        block.push(`⏳ 剩 ${d} 天 (${until} 到期)`);
    }

    // 临期续费提醒 (阈值 BoxJs 可调, 默认 7 天)
    const warn = parseInt($.getdata(KEY_RENEW_WARN), 10) || 7;
    if (d !== null && d >= 0) {
        if (d === 0) block.push('‼️ 今天是本期最后一天, 记得续费');
        else if (d <= 3) block.push(`❗️ 仅剩 ${d} 天 (${until} 到期), 记得续费`);
        else if (d <= warn) block.push(`⏰ 剩 ${d} 天 (${until} 到期), 记得续费`);
    }
    return block;
}

async function runTasks() {
    const accountsStr = $.getdata(XINYUE_DATA_KEY);
    if (!accountsStr) {
        return $.msg($.name, '❌ 未找到配置', '请先打开一次"悦享卡"页面以完成初始化。');
    }
    const accounts = $.toObj(accountsStr, []);
    if (!accounts.length) return;

    $.log(`共发现 ${accounts.length} 个账号, 开始执行...`);
    const blocks = [];
    let allOk = true;
    for (let i = 0; i < accounts.length; i++) {
        $.index = i + 1;
        const block = await processAccount(accounts[i]);
        if (block.some((l) => l.includes('❌'))) allOk = false;
        blocks.push(block);
        if (i < accounts.length - 1) await $.wait(2000);
    }

    // 日志: 过程细节已在上文逐步展示, 这里只留单行摘要; 完整富信息块交给系统通知
    const ok = blocks.filter((b) => b.some((l) => l.includes('✅'))).length;
    const rep = blocks.filter((b) => !b.some((l) => l.includes('✅')) && b.some((l) => l.includes('🔁'))).length;
    const warnN = blocks.filter((b) => b.some((l) => l.includes('⚠️'))).length;
    const fail = blocks.filter((b) => b.some((l) => l.includes('❌'))).length;
    $.log();
    $.log('──────────── 执行结果 ────────────');
    blocks.forEach((block, i) => {
        $.log(`  ${i + 1}. ${block.map((l) => l.replace(/^👤\s*/, '')).join(' · ')}`);
    });
    $.log(`  共 ${blocks.length} 个账号 · 成功 ${ok} · 重复 ${rep}`
        + (warnN ? ` · 待处理 ${warnN}` : '') + (fail ? ` · 失败 ${fail}` : ''));

    const notifySuccess = $.getdata(KEY_NOTIFY_SUCCESS) !== 'false';
    const title = `心悦悦享卡 (${$.time('MM-dd')})`;
    if (allOk && !notifySuccess) {
        $.log('全部成功/重复, 按设置不发送通知。');
    } else {
        $.msg($.name, title, blocks.map((b) => b.join('\n')).join('\n'));
    }
}

function claimReward(acc) {
    return new Promise((resolve) => {
        const { token, openid, headers, claimBody } = acc;
        // displayName 优先; 兼容 v9.2 及更早存的配置(那时 nickname 存的是显示名)
        const name = acc.displayName || acc.nickname || openid;
        if (!headers || !claimBody) {
            return resolve(`👤 [${name}]: ❌ 缺少配置, 请重新抓取。`);
        }
        if (!acc.record_id) {
            return resolve(`👤 [${name}]: ⚠️ 未识别到已开通的卡, 请打开「我的卡」页面重新抓取。`);
        }

        const dynamicHeaders = { ...headers };
        dynamicHeaders['T-ACCESS-TOKEN'] = token;
        dynamicHeaders['T-OPENID'] = openid;
        delete dynamicHeaders['Content-Length'];

        // 过程日志由 processAccount 统一输出 (▶️/📡/🎫/🎁)
        $.post({ url: CLAIM_URL, method: 'POST', headers: dynamicHeaders, body: claimBody }, (error, response, data) => {
            if ($.getdata(KEY_DEBUG_LOG) === 'true') rawResponses.push(`${name}: ${data}`);
            resolve(summarize(name, error, data));
        });
    });
}

function summarize(name, error, data) {
    const head = `👤 [${name}]: `;
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
