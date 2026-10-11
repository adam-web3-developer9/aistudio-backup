import { MioraApiError } from './miora-api.js';

/** Only MiniMax H3 on Miora has this confirmed upstream limit (JS string length). */
export const MIORA_H3_PROMPT_LIMIT = 2_000;

// Match each default appended rule in full before dividing it into independent
// clauses. Customized rules stay whole and keep their original wording.
const DEFAULT_RULE_REPLACEMENTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["【现实标志与货币替换】画面中出现中国党政机关、执法机关（公安、法院、检察院、城管、军队等）的标志、旗帜、徽章、牌匾、制服标识，或现行人民币纸币与硬币时，一律替换为对应的美国机构形象、美国标志或美元实物；无直接对应项时使用虚构的美式机构标志。替换只针对上述标志、徽章、旗帜、制服标识和货币实物本身，不改变场景、人物、剧情和其他画面元素；画面内可读文字默认简体中文，金额按剧本原文以“元”书写，仅在剧本明确要求时使用英文。", ["中国党政/执法标志换美国对应标志，无对应则虚构。", "人民币实物换美元；场景/剧情不变。", "画面文字用简中，金额按原文用元，原文要求英文则用英文。"]],
  ["【二维码与网址脱敏】画面中出现二维码、小程序码、付款码、收款码、条形码等可扫码图形时，码区主体一律替换为同尺寸的卡通图案（卡通笑脸、小动物、几何萌图等可爱平面图形），保留原有的白色方框、描边、摆放位置和相对大小，使它在构图上仍然是“一张贴着的码”。禁止画出可被真实设备扫描识别的码点矩阵、三个定位角标、对齐标记和细密黑白模块，禁止在码区内写真实文字或数字。画面中出现网址、域名、短链、二维码下方说明链接、公众号或小程序名称、App 下载地址，以及手机号、微信号、QQ号、邮箱、银行卡号等可联系或可访问的信息时，一律改写为明显虚构且无法访问的占位内容：域名统一用 example 一类保留域名，号码统一用连续相同数字或以 XXXX 遮挡中间位。本规则只替换上述码图与字符串本身，不改变场景、人物、剧情、构图、光线和其他画面元素；剧情需要“扫码”这个动作时照常演出，只是码面内容已脱敏。", ["二维码/条码等可扫码内容保留位置与白框，码面换不可扫卡通图。", "网址/账号/电话/邮箱/银行卡号改不可访问的虚构占位(example/重复数字/XXXX)。", "照常演出扫码动作，其他画面不变。"]],
  ["【统一人声规则】所有人声使用标准普通话，不带地方口音，包括角色、群演、旁白及背景可辨识人声。音色设定不得包含方言、地域口音或地域语感；保留人物原有的音高、音质、共鸣、气息、语速、停顿、重音、情绪和说话习惯。", ["所有人声标准普通话，不带方言。", "保留原音色、语速、停顿和情绪。"]]
];

/** Only the user's shot description is required. Generated context uses leftover space. */
export function prepareMioraPrompt(prompt: string, model: string): string {
  if (!/^minimax-h3(?:-max)?$/i.test(model) || prompt.length <= MIORA_H3_PROMPT_LIMIT) return prompt;
  let body = prompt;
  const optionalRules: string[] = [];
  const ruleHeaders = ['【现实标志与货币替换】', '【二维码与网址脱敏】', '【统一人声规则】'];
  // Aistudio appends these paragraphs after the shot. Recognize their headings
  // even when their contents were customized, without rewriting custom text.
  for (const header of [...ruleHeaders].reverse()) {
    const at = body.lastIndexOf('\n\n' + header);
    if (at < 0) continue;
    const tail = body.slice(at + 2);
    if (ruleHeaders.some((other) => other !== header && tail.includes('\n\n' + other))) continue;
    body = body.slice(0, at);
    optionalRules.unshift(tail);
  }
  // Aistudio also appends a visual-style block after the shot description.
  // Treat that generated block as optional while preserving its full wording.
  let optionalStyle = '';
  const styleStart = body.lastIndexOf('\n\n【视频风格提示词】\n');
  const styleEnd = '\n执行要求：以上风格仅作为视频生成的画面风格、镜头质感、光影和运动方式约束；不得改变剧情、角色、台词和时长。';
  if (styleStart >= 0 && body.endsWith(styleEnd)) {
    optionalStyle = body.slice(styleStart + 2);
    body = body.slice(0, styleStart);
  }
  const reference = compactReferenceLegend(body);
  body = reference.body;
  if (body.length > MIORA_H3_PROMPT_LIMIT) {
    throw new MioraApiError(400, 'PROMPT_LENGTH_EXCEEDED',
      '分镜正文共 ' + body.length + ' 字符，Miora ' + model + ' 最多 ' + MIORA_H3_PROMPT_LIMIT + '；请精简分镜正文。未截断对白，任务未提交。',
      '/media-generate/video');
  }
  let result = body;
  if (reference.entries.length) {
    const prefix = '【参考素材对照｜系统绑定】';
    const selected: string[] = [];
    for (const entry of reference.entries) {
      const next = [...selected, entry];
      const legend = prefix + next.join('；') + '。';
      if (legend.length + 1 + body.length <= MIORA_H3_PROMPT_LIMIT) selected.push(entry);
    }
    if (selected.length) {
      let legend = prefix + selected.join('；') + '。';
      const note = '标记按附带素材顺序对应，故事板按编号仅参考相应段落构图与镜头起点，不跨张拼接；参考图勿带入白底/三视图/资产卡/宫格/边框/编号/无关姿势及文字。';
      if (legend.length + note.length + 1 + body.length <= MIORA_H3_PROMPT_LIMIT) legend += note;
      result = legend + '\n' + body;
    }
  }
  if (optionalStyle && result.length + optionalStyle.length + 2 <= MIORA_H3_PROMPT_LIMIT) {
    result += '\n\n' + optionalStyle;
  }
  // Add complete clauses in source order. A smaller later clause may still fit
  // when an earlier one cannot; never slice a clause to meet the budget.
  for (const original of optionalRules) {
    const fragments = DEFAULT_RULE_REPLACEMENTS.find(([full]) => full === original)?.[1] ?? [original];
    for (const fragment of fragments) {
      const extra = '\n\n' + fragment;
      if (result.length + extra.length <= MIORA_H3_PROMPT_LIMIT) result += extra;
    }
  }
  return result;
}

function compactReferenceLegend(prompt: string): { body: string; entries: string[] } {
  const header = '【参考素材对照｜系统绑定】\n';
  if (!prompt.startsWith(header)) return { body: prompt, entries: [] };
  const end = prompt.indexOf('\n\n', header.length);
  if (end < 0) return { body: prompt, entries: [] };
  const lines = prompt.slice(header.length, end).split('\n');
  const footer = '以上标记与随请求附带的素材按顺序一一对应；正文中「名称（标记）」即指该素材。最终画面不得复现参考图的白底、三视图、资产卡、宫格、边框、编号或文字。';
  if (lines.at(-1) === footer) lines.pop();
  const entries: string[] = [];
  let storyboard = 0;
  for (const line of lines) {
    const story = line.match(/^(<Picture \d+>)：(.+)，只参考构图、画格顺序与(镜头起点|状态承接)，不复现宫格边框和编号$/);
    if (story && ((story[3] === '镜头起点' && /^本镜(?:首帧故事板|第1张故事板（同时作为首帧）)$/.test(story[2]!)) || (story[3] === '状态承接' && storyboard > 0))) {
      storyboard += 1;
      entries.push(story[1]! + '故事板' + storyboard + (story[3] === '状态承接' ? '(' + story[2] + ')' : ''));
      continue;
    }
    if (line.startsWith('正文中的“故事板N第X格”按顺序对应：')) {
      // Numbered storyboards above retain exactly the same markers and order.
      if (storyboard < 2 || !line.includes('不得跨张取格')) entries.push(line);
      continue;
    }
    const asset = line.match(/^(<Picture \d+>)：(角色|场景|物品)「([^」]+)」参考图；只控制：([^；]+)；不控制：(.+)$/);
    if (asset) {
      const token = asset[1]!;
      const kind = asset[2]!;
      const name = asset[3]!;
      const may = asset[4]!;
      const mustNot = asset[5]!;
      const exclusion = '白底、三视图布局、资产卡、宫格边框、编号文字、无关姿势、无关构图';
      const allowed: Record<string, string> = {
        '身份、脸型五官、体型、发型、当前服装版本': '身份/五官/体型/发型/服装',
        '空间结构、入口门窗、固定锚点、材质、当前光线状态': '结构/门窗/锚点/材质/光线',
        '外形、材质、结构、当前状态': '外形/材质/结构/状态'
      };
      if (mustNot === exclusion && allowed[may]) entries.push(token + kind + name + '(' + allowed[may] + ')');
      else entries.push(line);
      continue;
    }
    const video = line.match(/^(<Video \d+>)：视觉符号参考视频，只参考其中的符号形态与动态，不搬运其画面内容$/);
    if (video) { entries.push(video[1]! + '符号形态/动态，不搬画面'); continue; }
    const audio = line.match(/^(<Audio \d+>)：「([^」]+)」音色参考，只控制该角色说话的音色、语速和语感，不搬运其中台词$/);
    if (audio) { entries.push(audio[1]! + audio[2]! + '音色/语速/语感，不搬台词'); continue; }
    entries.push(line);
  }
  if (!entries.length) return { body: prompt, entries: [] };
  return { body: prompt.slice(end + 2), entries };
}
