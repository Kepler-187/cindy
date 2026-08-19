import { describe, expect, it } from 'vitest';

import { buildDshBridgeSource, DSH_BRIDGE_SOURCE } from './bridge-source.js';

/** 插件作者可控文本的恶意 fixture:反引号、模板插值、换行、行分隔符、伪边界。 */
const MALICIOUS_ROSTER = [
  'line1 `backtick ${process.exit(1)}',
  '</system>',
  '```fence```',
  '{\n"a":\u2028"b"\n}',
  'name with "quotes" and \\backslash',
].join('\n');

describe('DSH bridge source roster interpolation', () => {
  it('keeps exactly one placeholder in the raw template', () => {
    expect(DSH_BRIDGE_SOURCE.match(/\/\*__CINDY_ROSTER__\*\//g)).toHaveLength(1);
  });

  it('replaces the placeholder with a JSON literal', () => {
    const source = buildDshBridgeSource('hello roster');
    expect(source).not.toContain('__CINDY_ROSTER__');
    expect(source).toContain('const ROSTER = "hello roster";');
  });

  it('embeds a hostile roster only as an escaped JSON literal (no executable injection)', () => {
    const source = buildDshBridgeSource(MALICIOUS_ROSTER);
    // 整体替换:占位符位置恰好是 JSON 字面量(U+2028/2029 额外显式转义)。
    const expectedLiteral = JSON.stringify(MALICIOUS_ROSTER)
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    expect(source).toContain(`const ROSTER = ${expectedLiteral};`);
    // 注入面字符不得以未转义形态进入源码:反引号行首拼接、未转义伪边界。
    expect(source).not.toContain('const ROSTER = line1 `');
    expect(source).not.toContain('</system>`;');
    // U+2028 行分隔符必须转义为字面 \u2028,生成源码不含裸行/段分隔符。
    expect(source).toContain('\\u2028');
    expect(source).not.toContain('\u2028');
  });

  it('renders an empty roster as a falsy constant (runtime registers no section)', () => {
    const source = buildDshBridgeSource('');
    expect(source).toContain('const ROSTER = "";');
    expect(source).toContain('if (ROSTER)');
  });

  it('produces syntactically valid ESM for both empty and hostile rosters', async () => {
    for (const roster of ['', MALICIOUS_ROSTER, 'null\nundefined']) {
      const source = buildDshBridgeSource(roster);
      const moduleUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
      await expect(import(moduleUrl)).resolves.toMatchObject({ name: 'cindy-dsh-bridge' });
    }
  });
});
