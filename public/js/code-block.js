/* 代码块增强：语言标签 + 复制按钮
 * 注入到 .post-content 内的每个 .highlight 代码块
 */
(function () {
  'use strict';

  var LANG_NAMES = {
    go: 'Go', golang: 'Go',
    yaml: 'YAML', yml: 'YAML', toml: 'TOML', json: 'JSON', ini: 'INI', conf: 'Conf',
    bash: 'Bash', sh: 'Shell', shell: 'Shell', zsh: 'Shell', console: 'Console',
    js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript',
    py: 'Python', python: 'Python', rb: 'Ruby',
    c: 'C', cpp: 'C++', 'c++': 'C++', java: 'Java', sql: 'SQL', rust: 'Rust', rs: 'Rust',
    html: 'HTML', xml: 'XML', css: 'CSS', scss: 'SCSS', less: 'Less',
    dockerfile: 'Dockerfile', makefile: 'Makefile', nginx: 'Nginx',
    md: 'Markdown', markdown: 'Markdown', text: 'Text', plaintext: 'Text', '': 'Code'
  };

  function langLabel(dataLang) {
    if (!dataLang) return 'Code';
    return LANG_NAMES[dataLang.toLowerCase()] || dataLang;
  }

  function copyText(text, btn) {
    function done(ok) {
      btn.textContent = ok ? '已复制' : '复制失败';
      btn.classList.toggle('copied', ok);
      setTimeout(function () {
        btn.textContent = '复制';
        btn.classList.remove('copied');
      }, 1600);
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } else {
      fallback();
    }
  }

  function enhance(block) {
    if (block.querySelector('.code-header')) return;
    var code = block.querySelector('pre code');
    if (!code) return;
    var pre = block.querySelector('pre');

    var header = document.createElement('div');
    header.className = 'code-header';

    var label = document.createElement('span');
    label.className = 'code-lang';
    label.textContent = langLabel(code.getAttribute('data-lang'));
    header.appendChild(label);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.textContent = '复制';
    btn.setAttribute('aria-label', '复制代码');
    btn.addEventListener('click', function () {
      copyText(code.innerText, btn);
    });
    header.appendChild(btn);

    block.insertBefore(header, pre);
  }

  function enhanceAll() {
    document.querySelectorAll('.post-content .highlight').forEach(enhance);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhanceAll);
  } else {
    enhanceAll();
  }
})();
