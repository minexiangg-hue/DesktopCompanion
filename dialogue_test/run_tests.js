/**
 * dialogue_test/run_tests.js — 六人格对话搜索链路测试
 *
 * 用法: node dialogue_test/run_tests.js
 * 输出: dialogue_test/reports/ 下每个人格一份报告 + 汇总
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PERSONALITIES_DIR = path.join(ROOT, 'src', 'personalities');
const REPORTS_DIR = path.join(__dirname, 'reports');

// ============================================================
// 加载模块
// ============================================================
const personalityScheduler = require(path.join(ROOT, 'src', 'js', 'personality-scheduler'));
const sleepScheduler = require(path.join(ROOT, 'src', 'js', 'sleep-scheduler'));
const WebSearch = require(path.join(ROOT, 'src', 'js', 'web-search'));
const ChatEngine = require(path.join(ROOT, 'src', 'js', 'chat-engine'));

// ============================================================
// Monkey-patch WebSearch 以捕获搜索调用详情和 URL
// ============================================================
const searchLog = [];

class InstrumentedWebSearch extends WebSearch {
  constructor(dataDir) { super(dataDir); }

  async query(terms, opts = {}) {
    const entry = { method: 'query', terms, opts, results: [] };
    const result = await super.query(terms, opts);
    entry.results = result ? result.map(r => ({ title: r.title, source: r.source, url: r.url || '' })) : [];
    searchLog.push(entry);
    return result;
  }

  async trending(opts = {}) {
    const entry = { method: 'trending', opts, results: [] };
    const result = await super.trending(opts);
    entry.results = result ? result.map(r => ({ title: r.title, source: r.source, url: r.url || '' })) : [];
    searchLog.push(entry);
    return result;
  }

  async searchNews(terms, limit) {
    const entry = { method: 'searchNews', terms, limit, results: [] };
    const result = await super.searchNews(terms, limit);
    entry.results = result ? result.map(r => ({ title: r.title, source: r.source, url: r.url || '' })) : [];
    searchLog.push(entry);
    return result;
  }
}

// ============================================================
// 对话脚本（25 轮）
// ============================================================
const conversationScript = [
  // --- 段 1：开场问候 + 日常闲聊 (5轮) ---
  { msg: '你好呀',                                    cat: 'greeting' },
  { msg: '今天天气真好啊',                            cat: 'weather' },
  { msg: '你今天在做什么呢',                          cat: 'whatdoing' },
  { msg: '我昨天晚上睡得特别好',                      cat: 'daily' },
  { msg: '你吃饭了吗',                                cat: 'eaten' },

  // --- 段 2：情绪表达 + 互动 (5轮) ---
  { msg: '我今天心情特别好',                          cat: 'happy' },
  { msg: '哈哈哈你好好玩',                            cat: 'cute' },
  { msg: '最近工作压力好大啊',                        cat: 'tired' },
  { msg: '有没有什么开心的事可以分享一下',            cat: 'recommend' },
  { msg: '你觉得我这个人怎么样',                      cat: 'daily' },

  // --- 段 3：明显搜索请求 (5轮) ---
  { msg: '帮我搜索一下最新的科技新闻',                cat: 'search_explicit' },
  { msg: '查一下量子计算是什么',                      cat: 'search_explicit' },
  { msg: '帮我找找Python和JavaScript的区别',          cat: 'search_explicit' },
  { msg: '搜一下最近有什么好电影',                    cat: 'search_explicit' },
  { msg: '帮我查查今天有什么新闻大事',                cat: 'news_explicit' },

  // --- 段 4：不明显搜索请求 (5轮) ---
  { msg: '最近AI圈有什么新鲜事吗',                    cat: 'search_implicit' },
  { msg: '那个新出的Apple Vision Pro到底怎么样啊',    cat: 'search_implicit' },
  { msg: '量子纠缠是什么原理，能简单讲讲吗',          cat: 'search_implicit' },
  { msg: '人类登陆火星的技术难点主要有哪些',          cat: 'search_implicit' },
  { msg: '比特币最近涨了还是跌了',                    cat: 'search_implicit' },

  // --- 段 5：闲聊收尾 (5轮) ---
  { msg: '好了不说这些了，聊点别的吧',                cat: 'daily' },
  { msg: '你喜欢什么颜色',                            cat: 'daily' },
  { msg: '周末有什么好玩的推荐吗',                    cat: 'recommend' },
  { msg: '我要去上班了，拜拜',                        cat: 'leaving' },
  { msg: '明天见哦',                                  cat: 'greeting' },
];

// ============================================================
// 主流程
// ============================================================
async function runAllTests() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  personalityScheduler.init(PERSONALITIES_DIR);

  // 为测试使用独立的临时目录，避免真实 sleep-config.json 中的 chatCount 累积
  const TEST_DATA_DIR = path.join(__dirname, '..', 'data');

  const allPersonalities = personalityScheduler.getAll();

  console.log(`\n========================================`);
  console.log(`对话测试开始 — ${allPersonalities.length} 个人格 × ${conversationScript.length} 轮`);
  console.log(`========================================\n`);

  const summaryRows = [];

  for (const meta of allPersonalities) {
    const pid = meta.id;
    const pname = meta.name;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎭 测试人格: ${pname} (${pid})`);
    console.log(`${'='.repeat(60)}`);

    personalityScheduler.switchTo(pid);

    // 为每个人格使用独立的临时 sleep config，重置每日限额
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-'));
    const tmpSleepDir = path.join(tmpDir, 'sleep');
    fs.mkdirSync(tmpSleepDir, { recursive: true });
    // 写入白名单 sleep-config：高限额 + 始终清醒
    fs.writeFileSync(path.join(tmpSleepDir, 'sleep-config.json'), JSON.stringify({
      wakeUp: '00:00', sleepTime: '23:59', maxDailyChats: 999, cooldownSeconds: 0, drowsyResponseLimit: 0
    }));
    sleepScheduler.init(tmpSleepDir);

    searchLog.length = 0;
    const ws = new InstrumentedWebSearch(DATA_DIR);
    const ce = new ChatEngine(personalityScheduler, sleepScheduler, null, null, ws, DATA_DIR);
    ce.init();
    // 绕过会话轮次限制以便完整测试 25 轮
    ce.maxTurnsPerSession = 999;
    ce.maxHistoryTurns = 999;

    const dialogueRows = [];
    let searchTriggerCount = 0;

    for (let i = 0; i < conversationScript.length; i++) {
      const turn = conversationScript[i];
      const msg = turn.msg;
      const intent = ce._detectIntent(msg);
      const beforeLen = searchLog.length;
      const rawResponse = await ce.respond(msg);
      const responseText = typeof rawResponse === 'object' ? rawResponse.text : rawResponse;
      const searchPerformed = (typeof rawResponse === 'object' && rawResponse.searchPerformed) ||
                              (searchLog.length > beforeLen);
      const sources = (typeof rawResponse === 'object' && rawResponse.sources) || [];
      if (searchPerformed) searchTriggerCount++;

      const newSearches = searchLog.slice(beforeLen);
      const urls = newSearches.flatMap(s => s.results.map(r => r.url).filter(Boolean));
      const searchMethods = newSearches.map(s => `${s.method}("${s.terms || ''}")`);

      dialogueRows.push({
        turn: i + 1, category: turn.cat, message: msg, intent,
        searchTriggered: searchPerformed, searchMethods, urls,
        response: responseText, sources,
      });

      const marker = searchPerformed ? `🔍 [${searchMethods.join(', ')}]` : '✗';
      console.log(`  [${String(i+1).padStart(2)}] "${msg.substring(0,35)}..." → intent=${intent} ${marker}`);
      if (urls.length > 0) urls.forEach(u => console.log(`       ↳ ${u}`));
    }

    // 统计
    const explicitRows = dialogueRows.filter(r => ['search_explicit','news_explicit'].includes(r.category));
    const implicitRows = dialogueRows.filter(r => r.category === 'search_implicit');
    const nonSearchRows = dialogueRows.filter(r =>
      !['search_explicit','news_explicit','search_implicit'].includes(r.category));

    summaryRows.push({
      personality: pname, id: pid, totalTurns: conversationScript.length, searchTriggerCount,
      explicitHit: explicitRows.filter(r => r.searchTriggered).length,
      implicitHit: implicitRows.filter(r => r.searchTriggered).length,
      falsePositives: nonSearchRows.filter(r => r.searchTriggered),
    });

    writeReport(pname, pid, dialogueRows, searchTriggerCount, conversationScript.length);
  }

  writeSummary(summaryRows);
  console.log(`\n✅ 所有测试完成。报告: ${REPORTS_DIR}/\n`);
}

// ============================================================
// 写人格报告
// ============================================================
function writeReport(pname, pid, rows, searchCount, totalTurns) {
  const filepath = path.join(REPORTS_DIR, `${pid}.md`);

  let md = `# ${pname} (${pid}) — 对话搜索链路测试\n\n`;
  md += `> 测试轮数: **${totalTurns}** | 搜索触发: **${searchCount}次** | 触发率: **${(searchCount/totalTurns*100).toFixed(1)}%**\n\n`;
  md += `---\n\n## 逐轮记录\n\n`;
  md += `| # | 类别 | 用户输入 | 意图 | 搜索 | 搜索方法 | 回复 (截断) |\n`;
  md += `|---|------|---------|------|------|---------|----------|\n`;

  for (const row of rows) {
    const icon = row.searchTriggered ? '🔍' : '—';
    const methods = row.searchMethods.length > 0 ? row.searchMethods.join(', ') : '—';
    const msg = row.message.length > 22 ? row.message.substring(0, 22) + '…' : row.message;
    const resp = (row.response || '…').length > 45 ? (row.response || '…').substring(0, 45) + '…' : (row.response || '…');
    md += `| ${row.turn} | ${row.category} | ${msg} | \`${row.intent}\` | ${icon} | ${methods} | ${resp} |\n`;
  }

  md += `\n---\n\n## 分析\n\n`;

  const explicitRows = rows.filter(r => ['search_explicit','news_explicit'].includes(r.category));
  const implicitRows = rows.filter(r => r.category === 'search_implicit');
  const nonSearchRows = rows.filter(r => !['search_explicit','news_explicit','search_implicit'].includes(r.category));
  const explicitHit = explicitRows.filter(r => r.searchTriggered).length;
  const implicitHit = implicitRows.filter(r => r.searchTriggered).length;
  const fps = nonSearchRows.filter(r => r.searchTriggered);

  md += `### 搜索触发统计\n`;
  md += `| 消息类别 | 总数 | 触发搜索 | 命中率 |\n`;
  md += `|---------|------|---------|--------|\n`;
  md += `| 明显搜索请求 | ${explicitRows.length} | ${explicitHit} | ${(explicitHit/explicitRows.length*100).toFixed(0)}% |\n`;
  md += `| 不明显搜索请求 | ${implicitRows.length} | ${implicitHit} | ${(implicitHit/implicitRows.length*100).toFixed(0)}% |\n`;
  md += `| 非搜索闲聊 | ${nonSearchRows.length} | ${fps.length} | ${fps.length > 0 ? (fps.length/nonSearchRows.length*100).toFixed(0) : '0'}% |\n`;

  if (fps.length > 0) {
    md += `\n### ⚠️ 误触发（非搜索消息触发了搜索）\n`;
    for (const fp of fps) {
      md += `- 轮次 ${fp.turn}: **"${fp.message}"** → 意图 \`${fp.intent}\`\n`;
    }
  }

  const missed = explicitRows.filter(r => !r.searchTriggered);
  if (missed.length > 0) {
    md += `\n### ⚠️ 漏触发（明显搜索请求未触发搜索）\n`;
    for (const m of missed) {
      md += `- 轮次 ${m.turn}: **"${m.message}"** → 意图 \`${m.intent}\`\n`;
    }
  }

  const allUrls = rows.filter(r => r.urls.length > 0).flatMap(r => r.urls);
  const uniqueUrls = [...new Set(allUrls)];
  if (uniqueUrls.length > 0) {
    md += `\n### 搜索 URL 汇总 (${uniqueUrls.length} 个)\n`;
    for (const url of uniqueUrls) md += `- ${url}\n`;
  }

  // 完整对话附录
  md += `\n---\n\n## 附录：完整对话内容\n\n`;
  for (const row of rows) {
    md += `**用户 (轮次${row.turn})**: ${row.message}\n\n`;
    md += `**${pname}**: ${row.response}\n\n`;
    if (row.searchTriggered) {
      md += `> 🔍 搜索触发 | 意图: \`${row.intent}\` | 方法: ${row.searchMethods.join(', ') || '—'}\n`;
      if (row.urls.length > 0) md += `> URL: ${row.urls.join(', ')}\n`;
      md += `\n`;
    }
    md += `---\n\n`;
  }

  fs.writeFileSync(filepath, md, 'utf-8');
  console.log(`  📄 ${filepath}`);
}

// ============================================================
// 汇总报告
// ============================================================
function writeSummary(rows) {
  const filepath = path.join(REPORTS_DIR, '00_SUMMARY.md');

  let md = `# 六人格对话搜索链路 — 汇总报告\n\n`;
  md += `> 测试日期: ${new Date().toISOString().split('T')[0]} | 模式: 模板模式 | 每人格轮数: 25\n\n`;
  md += `---\n\n## 总览\n\n`;
  md += `| 人格 | 搜索触发率 | 明显搜索命中 | 不明显搜索命中 | 闲聊误触发 |\n`;
  md += `|------|-----------|-------------|---------------|----------|\n`;

  for (const row of rows) {
    const rate = (row.searchTriggerCount / row.totalTurns * 100).toFixed(0);
    const explicitTotal = 6; // 5 search_explicit + 1 news_explicit
    const implicitTotal = 5;
    const fpSummary = row.falsePositives.length > 0
      ? row.falsePositives.map(f => `"${f.message.substring(0,15)}…"(${f.intent})`).join(', ')
      : '—';
    md += `| ${row.personality} | ${rate}% | ${row.explicitHit}/${explicitTotal} | ${row.implicitHit}/${implicitTotal} | ${fpSummary} |\n`;
  }

  md += `\n---\n\n## 关键问题\n\n`;

  const allFps = rows.flatMap(r => r.falsePositives.map(f => ({ personality: r.personality, ...f })));
  if (allFps.length > 0) {
    md += `### 闲聊误触发搜索（共 ${allFps.length} 次）\n\n`;
    for (const fp of allFps) {
      md += `- **[${fp.personality}]** 轮次${fp.turn}: "${fp.message}" → intent=\`${fp.intent}\`\n`;
    }
    md += `\n**根因**: 语义意图匹配过于宽泛，将日常提问也识别为搜索。\n`;
  }

  md += `\n### 意图检测分析\n\n`;
  md += `当前 ` + "`_detectIntent()`" + ` 有三层搜索意图匹配：\n`;
  md += `1. 显式搜索关键词 (搜索/查/serch/find 等)\n`;
  md += `2. 语义知识查询 (是什么/为什么/怎么/如何/介绍一下 等)\n`;
  md += `3. default_searchable 兜底 (未匹配+实质性内容+非语气词)\n\n`;
  md += `**问题**: 第2层和第3层会捕获大量非搜索的日常提问（如"你觉得我这个人怎么样"），导致误触发。\n\n`;

  md += `---\n\n## 详细报告\n\n`;
  for (const row of rows) {
    md += `- [${row.personality} (${row.id})](./${row.id}.md)\n`;
  }

  fs.writeFileSync(filepath, md, 'utf-8');
  console.log(`  📊 ${filepath}`);
}

// 启动
runAllTests().catch(err => { console.error('测试失败:', err); process.exit(1); });
