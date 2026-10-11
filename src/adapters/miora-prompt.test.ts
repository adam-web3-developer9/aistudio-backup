import { describe, expect, it } from 'vitest';
import { MioraApiError } from './miora-api.js';
import { prepareMioraPrompt } from './miora-prompt.js';

const originalLegend = "【参考素材对照｜系统绑定】\n<Picture 1>：本镜首帧故事板，只参考构图、画格顺序与镜头起点，不复现宫格边框和编号\n<Picture 2>：角色「秦师傅」参考图；只控制：身份、脸型五官、体型、发型、当前服装版本；不控制：白底、三视图布局、资产卡、宫格边框、编号文字、无关姿势、无关构图\n<Picture 3>：角色「冯国强」参考图；只控制：身份、脸型五官、体型、发型、当前服装版本；不控制：白底、三视图布局、资产卡、宫格边框、编号文字、无关姿势、无关构图\n<Picture 4>：场景「第一食堂就餐大厅」参考图；只控制：空间结构、入口门窗、固定锚点、材质、当前光线状态；不控制：白底、三视图布局、资产卡、宫格边框、编号文字、无关姿势、无关构图\n<Picture 5>：物品「第一食堂鸡腿饭宣传牌」参考图；只控制：外形、材质、结构、当前状态；不控制：白底、三视图布局、资产卡、宫格边框、编号文字、无关姿势、无关构图\n以上标记与随请求附带的素材按顺序一一对应；正文中「名称（标记）」即指该素材。最终画面不得复现参考图的白底、三视图、资产卡、宫格、边框、编号或文字。\n\n";
const defaultAppendix = "【现实标志与货币替换】画面中出现中国党政机关、执法机关（公安、法院、检察院、城管、军队等）的标志、旗帜、徽章、牌匾、制服标识，或现行人民币纸币与硬币时，一律替换为对应的美国机构形象、美国标志或美元实物；无直接对应项时使用虚构的美式机构标志。替换只针对上述标志、徽章、旗帜、制服标识和货币实物本身，不改变场景、人物、剧情和其他画面元素；画面内可读文字默认简体中文，金额按剧本原文以“元”书写，仅在剧本明确要求时使用英文。\n\n【二维码与网址脱敏】画面中出现二维码、小程序码、付款码、收款码、条形码等可扫码图形时，码区主体一律替换为同尺寸的卡通图案（卡通笑脸、小动物、几何萌图等可爱平面图形），保留原有的白色方框、描边、摆放位置和相对大小，使它在构图上仍然是“一张贴着的码”。禁止画出可被真实设备扫描识别的码点矩阵、三个定位角标、对齐标记和细密黑白模块，禁止在码区内写真实文字或数字。画面中出现网址、域名、短链、二维码下方说明链接、公众号或小程序名称、App 下载地址，以及手机号、微信号、QQ号、邮箱、银行卡号等可联系或可访问的信息时，一律改写为明显虚构且无法访问的占位内容：域名统一用 example 一类保留域名，号码统一用连续相同数字或以 XXXX 遮挡中间位。本规则只替换上述码图与字符串本身，不改变场景、人物、剧情、构图、光线和其他画面元素；剧情需要“扫码”这个动作时照常演出，只是码面内容已脱敏。\n\n【统一人声规则】所有人声使用标准普通话，不带地方口音，包括角色、群演、旁白及背景可辨识人声。音色设定不得包含方言、地域口音或地域语感；保留人物原有的音高、音质、共鸣、气息、语速、停顿、重音、情绪和说话习惯。";
const shot = '【统一约束】\n全屏16:9单画面，禁止宫格或分屏。对白：“秦师傅，你现在也给一食堂指导菜了？”声音必须普通话。'.padEnd(1677, '镜');
const longPrompt = originalLegend + shot + '\n\n' + defaultAppendix;

describe('Miora prompt limit', () => {
  it('compacts generated material without changing the entire shot description or references', () => {
    expect(longPrompt.length).toBeGreaterThan(2000);
    const compact = prepareMioraPrompt(longPrompt, 'minimax-h3');
    expect(compact.length).toBeLessThanOrEqual(2000);
    expect(compact).toContain(shot);
    for (let number = 1; number <= 5; number++) expect(compact).toContain(`<Picture ${number}>`);
    expect(compact).toContain('【参考素材对照｜系统绑定】');
    expect(compact).toContain('中国党政/执法标志换美国对应标志');
    expect(compact).not.toContain('二维码/条码');
    expect(compact).not.toContain('【二维码与网址脱敏】');
  });

  it('keeps the entire body first and adds only whole rules that fit', () => {
    const body = '【分镜正文】' + '剧情'.repeat(850);
    const input = originalLegend + body + '\n\n' + defaultAppendix;
    const output = prepareMioraPrompt(input, 'minimax-h3');
    expect(output.length).toBeLessThanOrEqual(2000);
    expect(output).toContain(body);
    expect(output).not.toContain('【二维码与网址脱敏】');
    expect(output).not.toContain('【统一人声规则】');
    expect(output).not.toMatch(/画面中出现二维码|画面中出现网址/);
    expect(output).toContain('中国党政/执法标志换美国对应标志');
  });

  it('treats customized appended rules as optional whole blocks', () => {
    const custom = '【统一人声规则】' + '必须保持现场环境声音。'.repeat(15);
    const body = '剧情'.repeat(900);
    const input = originalLegend + body + '\n\n' + custom;
    const output = prepareMioraPrompt(input, 'minimax-h3');
    expect(output).toContain(body);
    expect(output).not.toContain(custom);
    expect(output.length).toBeLessThanOrEqual(2000);
  });

  it('keeps multiple storyboards mapped to their original picture numbers', () => {
    const extra = '<Picture 6>：本镜后半段故事板，只参考构图、画格顺序与状态承接，不复现宫格边框和编号\n正文中的“故事板N第X格”按顺序对应：故事板1=<Picture 1>、故事板2=<Picture 6>；各张只覆盖自己那段剧情，不得跨张取格，也不得把多张拼成一张画面。';
    const legend = originalLegend.replace('以上标记与随请求附带的素材', extra + '\n以上标记与随请求附带的素材');
    const text = legend + '故事板2第1格：人物转身。' + '镜'.repeat(1500) + '\n\n' + defaultAppendix;
    const result = prepareMioraPrompt(text, 'minimax-h3');
    expect(result).toContain('<Picture 1>故事板1');
    expect(result).toContain('<Picture 6>故事板2(本镜后半段故事板)');
    expect(result).toContain('故事板2第1格：人物转身。');
  });

  it('omits optional bindings even when their format is unfamiliar', () => {
    const changed = originalLegend.replace('身份、脸型五官、体型、发型、当前服装版本', '身份、手部伤痕');
    const body = '镜'.repeat(1950);
    const result = prepareMioraPrompt(changed + body + '\n\n' + defaultAppendix, 'minimax-h3');
    expect(result).toContain(body);
    expect(result).not.toContain('手部伤痕');
    expect(result.length).toBeLessThanOrEqual(2000);
  });

  it('sends the complete body when it uses the entire budget', () => {
    const body = '镜'.repeat(2000);
    expect(prepareMioraPrompt(originalLegend + body + '\n\n' + defaultAppendix, 'minimax-h3')).toBe(body);
  });

  it('keeps the first binding that fits and skips later oversized bindings', () => {
    const body = '镜'.repeat(1950);
    const result = prepareMioraPrompt(originalLegend + body + '\n\n' + defaultAppendix, 'minimax-h3');
    expect(result).toContain('<Picture 1>故事板1');
    expect(result).not.toContain('<Picture 2>');
    expect(result).toContain(body);
  });

  it('fits a smaller sub-rule even if an earlier sub-rule does not fit', () => {
    const body = '镜'.repeat(1975);
    const output = prepareMioraPrompt(body + '\n\n' + defaultAppendix, 'minimax-h3');
    expect(output).toContain(body);
    expect(output).not.toContain('中国党政/执法标志换美国对应标志');
    expect(output).toContain('人民币实物换美元');
    expect(output.length).toBeLessThanOrEqual(2000);
  });

  it('leaves every other model and a short H3 prompt unchanged', () => {
    expect(prepareMioraPrompt(longPrompt, 'other-model')).toBe(longPrompt);
    expect(prepareMioraPrompt('短提示词', 'minimax-h3')).toBe('短提示词');
  });

  it('rejects overlong user content without truncating dialogue or sending a job', () => {
    const tooLong = '对白：“这句话必须完整说完。”' + '剧情'.repeat(1100);
    expect(() => prepareMioraPrompt(tooLong, 'minimax-h3'))
      .toThrow(MioraApiError);
    expect(() => prepareMioraPrompt(tooLong, 'minimax-h3'))
      .toThrow('未截断对白，任务未提交');
  });
});
