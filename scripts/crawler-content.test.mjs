import { describe, expect, it } from 'vitest';
import { innerHtmlById, textLength } from './crawler-content.mjs';

// Pins the boundary behaviour of the #root-scoped crawler check (issue #81):
// before this guard, `html.includes()` was satisfied by the `.bbs-intro { }` CSS
// in <head> even with the real prose inside #root deleted.
describe('check:dist 爬虫正文提取', () => {
  it('按 div 深度取出 #root 的内部 HTML，嵌套 div 归属正确且不带 head 的 CSS', () => {
    const html =
      '<head><style>.bbs-intro { color: red }</style></head>' +
      '<div id="root"><div class="a"><p>面包板</p></div><div class="b">洞洞板</div></div>' +
      '<script src="/assets/x.js"></script>';
    const root = innerHtmlById(html, 'root');
    expect(root).toBe('<div class="a"><p>面包板</p></div><div class="b">洞洞板</div>');
    expect(root).not.toContain('bbs-intro');
    expect(textLength(root)).toBeGreaterThan(0);
  });

  it('空内容返回空串，正文计数为 0', () => {
    const html = '<div id="root"></div>';
    expect(innerHtmlById(html, 'root')).toBe('');
    expect(textLength(innerHtmlById(html, 'root'))).toBe(0);
  });

  it('元素缺失返回 null（check:dist 据此报错而不是静默通过）', () => {
    expect(innerHtmlById('<div id="other">面包板</div>', 'root')).toBeNull();
    expect(innerHtmlById('<p>no div at all</p>', 'root')).toBeNull();
  });

  it('标签未闭合返回 null，不误读文档尾部', () => {
    const html = '<div id="root"><div class="a">面包板</div>';
    expect(innerHtmlById(html, 'root')).toBeNull();
  });

  it('id 不是首属性时返回 null（当前构建产物总是 id 在前，见 dist/index.html）', () => {
    expect(innerHtmlById('<div class="x" id="root">面包板</div>', 'root')).toBeNull();
  });

  it('textLength 剥离 script/style/标签并折叠空白', () => {
    const markup =
      '<script>var a = 1;</script><style>.b{}</style>' +
      '<h1>面包板</h1>  <p>洞洞板  Studio</p>   <div></div>';
    expect(textLength(markup)).toBe('面包板 洞洞板 Studio'.length);
  });
});
