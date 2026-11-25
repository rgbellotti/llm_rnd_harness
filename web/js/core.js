// core.js — load first. Shared constants, session state, and generic
// helpers (formatting, clipboard, collapse math). No DOM wiring here;
// see boot.js for startup. Load order: core -> tabs -> rounds -> prompt
// -> approval -> stream -> storage -> history -> boot.
const COLLAPSE_LINES = 60;
const STORE_KEY = 'harness.tabs.v1';
const MAX_TABS = 20;
// Browser display preference. Built-in ids are 'blue-gold' and 'dark'.
// 'current' is the old name for blue and gold. User presets use p-prefixed
// ids. 'custom' means the working colors match no saved preset. The working
// colors and the preset list live in this browser only.
const HIGHLIGHT_STORE_KEY = 'harness.highlight';
const THEME_COLOR_KEY = 'harness.highlight.colors';
const THEME_PRESET_KEY = 'harness.highlight.presets';
const THEME_PRESET_LIMIT = 24;
// group, key, label, blue-and-gold, dark. Keys are the CSS variable suffix
// (--h-page). Dark values that match blue-and-gold are colors Dark mode
// leaves alone.
const THEME_FIELDS = [
    ['Page', 'page', 'Page background', '#223344', '#101418'],
    ['Page', 'text', 'Page text', '#aaaa77', '#c3cdb8'],
    ['Page', 'surface', 'Panels', '#112233', '#161b22'],
    ['Page', 'inset', 'Inset wells', '#0a1a28', '#0c1014'],
    ['Page', 'button', 'Buttons', '#051117', '#0c1014'],
    ['Page', 'button-text', 'Button text', '#acac79', '#d5d8de'],
    ['Page', 'border', 'Borders', '#334455', '#2c3644'],
    ['Page', 'heading', 'Headings', '#aaaa78', '#c3cdb8'],
    ['Page', 'title', 'Titles', '#caca8a', '#c3cdb8'],
    ['Page', 'active', 'Active tab text', '#caca8a', '#33bbdd'],
    ['Page', 'muted', 'Thinking text', '#8899aa', '#8b95a1'],
    ['Page', 'think-border', 'Thinking border', '#8899aa', '#3a4554'],
    ['Page', 'link', 'Links', '#7ab0d0', '#8eb4d4'],
    ['Page', 'code-bg', 'Code background', '#0a1a28', '#0c1014'],
    ['Page', 'code-fg', 'Code text', '#aaaa77', '#37a8c7'],
    ['Page', 'th-bg', 'Table header', '#0a1a28', '#12171e'],
    ['Page', 'td-bg', 'Table cell', '#0d1c2a', '#161b22'],
    ['Page', 'dock', 'Side lane', '#162433', '#0c1014'],
    ['Code', 'tok-comment', 'Comment', '#8292a2', '#adb5bd'],
    ['Code', 'tok-punct', 'Punctuation', '#a0b0c0', '#ced4da'],
    ['Code', 'tok-keyword', 'Keyword', '#e6db74', '#bb55f1'],
    ['Code', 'tok-tag', 'Tag', '#f92672', '#bb55f1'],
    ['Code', 'tok-property', 'Property', '#f92672', '#ffa94d'],
    ['Code', 'tok-param', 'Parameter', '#aaaa77', '#ffa94d'],
    ['Code', 'tok-constant', 'Constant', '#f92672', '#4dabf7'],
    ['Code', 'tok-number', 'Number', '#ae81ff', '#4dabf7'],
    ['Code', 'tok-string', 'String', '#a6e22e', '#69db7c'],
    ['Code', 'tok-char', 'Character', '#a6e22e', '#8ce99a'],
    ['Code', 'tok-attr', 'Attribute value', '#e6db74', '#8ce99a'],
    ['Code', 'tok-function', 'Function', '#66d9ef', '#b197fc'],
    ['Code', 'tok-operator', 'Operator', '#f8f8f2', '#e7eaee'],
    ['Code', 'tok-url', 'URL', '#f8f8f2', '#74c0fc'],
    ['Code', 'tok-regex', 'Regex', '#fd971f', '#ffa94d'],
    ['Chrome', 'metrics', 'Metrics', '#7a9a7a', '#7a9a7a'],
    ['Chrome', 'hint', 'Hints', '#8a9ab0', '#8a9ab0'],
    ['Chrome', 'tab', 'Quiet tab text', '#8a9ab0', '#d5d8de'],
    ['Chrome', 'status', 'Status line', '#888888', '#888888'],
    ['Chrome', 'error', 'Errors', '#e08080', '#e08080'],
    ['Chrome', 'warning', 'Warnings', '#e0c080', '#e0c080'],
    ['Chrome', 'warning-bg', 'Warning background', '#2a2214', '#2a2214'],
    ['Chrome', 'warning-border', 'Warning border', '#6a5a30', '#6a5a30'],
    ['Chrome', 'accent', 'Accent', '#22caa7', '#22caa7'],
    ['Chrome', 'accent-hover', 'Accent hover', '#4ae8c0', '#4ae8c0'],
    ['Chrome', 'menu', 'Menus', '#0d1c2a', '#0d1c2a'],
    ['Chrome', 'menu-hover', 'Menu hover', '#16283a', '#16283a'],
    ['Chrome', 'menu-label', 'Menu labels', '#77879a', '#77879a'],
    ['Chrome', 'disabled', 'Disabled text', '#4a5a68', '#4a5a68'],
    ['Chrome', 'option', 'Menu item', '#acac79', '#acac79'],
    ['Chrome', 'option-hover', 'Menu item hover', '#caca8a', '#caca8a'],
    ['Chrome', 'cloud', 'Cloud note', '#7d8b99', '#7d8b99'],
    ['Chrome', 'faint', 'Disabled title', '#5a6a78', '#5a6a78'],
    ['Chrome', 'prune', 'Prune note', '#b0a080', '#b0a080'],
    ['Chrome', 'preview', 'Preview text', '#999977', '#d5d8de'],
    ['Chrome', 'preview-bg', 'Preview background', '#0d1c2a', '#0c1014'],
    ['Chrome', 'tool-edge', 'Tool edge', '#4a6a8a', '#4a6a8a'],
    ['Chrome', 'tool-result', 'Result edge', '#6a8a4a', '#6a8a4a'],
    ['Chrome', 'stop', 'Stop border', '#8a4a4a', '#8a4a4a'],
    ['Chrome', 'stop-text', 'Stop text', '#e0a0a0', '#e0a0a0'],
    ['Chrome', 'focus', 'Focus border', '#4a6a8a', '#3a4554'],
    ['Chrome', 'generate', 'Generate button', '#2f7a4d', '#287255'],
    ['Chrome', 'generate-hover', 'Generate hover', '#3d9a63', '#2f8155'],
    ['Chrome', 'prov-bg', 'Provenance background', '#2e2410', '#2e2410'],
    ['Chrome', 'prov-edge', 'Provenance edge', '#d0a030', '#d0a030'],
    ['Chrome', 'prov-text', 'Provenance text', '#e8c878', '#e8c878'],
    ['Diff', 'diff-del', 'Removed line', '#7a303c', '#7a303c'],
    ['Diff', 'diff-add', 'Added line', '#1e5c3a', '#1e5c3a'],
    ['Diff', 'condense', 'Condensed tint', '#1a2740', '#17233a'],
    ['Diff', 'comment-bg', 'Comment highlight', '#e0c080', '#1e5c3a'],
    ['Diff', 'comment-text', 'Comment text', '#aaaa77', '#fffa00'],
    ['Diff', 'task-text', 'Task list text', '#aaaa77', '#aaaa77'],
    ['Diff', 'task-line', 'Task list line', '#2a3e50', '#2a3e50']
];
function normalizeHex(value) {
    if (typeof value !== 'string') return '';
    let v = value.trim();
    if (!v) return '';
    if (v.charAt(0) !== '#') v = '#' + v;
    if (/^#[0-9a-fA-F]{3}$/.test(v)) v = '#' + v.charAt(1) + v.charAt(1) + v.charAt(2) + v.charAt(2) + v.charAt(3) + v.charAt(3);
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return '';
    return v.toLowerCase();
}
function themeFields() {
    return THEME_FIELDS;
}
const SOLARIZED_DARK_COLORS = {
    'page': '#002b36', 'text': '#839496', 'surface': '#073642', 'inset': '#073642',
    'button': '#073642', 'button-text': '#839496', 'border': '#586e75', 'heading': '#93a1a1',
    'title': '#93a1a1', 'active': '#93a1a1', 'muted': '#586e75', 'think-border': '#586e75',
    'link': '#268bd2', 'code-bg': '#002b36', 'code-fg': '#839496', 'th-bg': '#073642',
    'td-bg': '#002b36', 'dock': '#073642', 'tok-comment': '#586e75', 'tok-punct': '#93a1a1',
    'tok-keyword': '#859900', 'tok-tag': '#dc322f', 'tok-property': '#cb4b16', 'tok-param': '#2aa198',
    'tok-constant': '#2aa198', 'tok-number': '#2aa198', 'tok-string': '#2aa198', 'tok-char': '#2aa198',
    'tok-attr': '#b58900', 'tok-function': '#268bd2', 'tok-operator': '#93a1a1', 'tok-url': '#268bd2',
    'tok-regex': '#cb4b16', 'metrics': '#859900', 'hint': '#586e75', 'tab': '#839496',
    'status': '#586e75', 'error': '#dc322f', 'warning': '#b58900', 'warning-bg': '#073642',
    'warning-border': '#b58900', 'accent': '#2aa198', 'accent-hover': '#2aa198', 'menu': '#073642',
    'menu-hover': '#002b36', 'menu-label': '#586e75', 'disabled': '#586e75', 'option': '#839496',
    'option-hover': '#93a1a1', 'cloud': '#586e75', 'faint': '#586e75', 'prune': '#b58900',
    'preview': '#839496', 'preview-bg': '#073642', 'tool-edge': '#268bd2', 'tool-result': '#859900',
    'stop': '#dc322f', 'stop-text': '#dc322f', 'focus': '#268bd2', 'prov-bg': '#073642',
    'prov-edge': '#b58900', 'prov-text': '#b58900', 'diff-del': '#dc322f', 'diff-add': '#859900',
    'condense': '#073642', 'comment-bg': '#b58900', 'comment-text': '#839496', 'task-text': '#839496',
    'task-line': '#073642'
};
const CATPPUCCIN_MOCHA_COLORS = {
    'page': '#1e1e2e', 'text': '#cdd6f4', 'surface': '#313244', 'inset': '#181825',
    'button': '#313244', 'button-text': '#cdd6f4', 'border': '#45475a', 'heading': '#cdd6f4',
    'title': '#cdd6f4', 'active': '#cdd6f4', 'muted': '#a6adc8', 'think-border': '#45475a',
    'link': '#89b4fa', 'code-bg': '#181825', 'code-fg': '#cdd6f4', 'th-bg': '#313244',
    'td-bg': '#1e1e2e', 'dock': '#181825', 'tok-comment': '#6c7086', 'tok-punct': '#9399b2',
    'tok-keyword': '#cba6f7', 'tok-tag': '#f38ba8', 'tok-property': '#f38ba8', 'tok-param': '#f38ba8',
    'tok-constant': '#fab387', 'tok-number': '#fab387', 'tok-string': '#a6e3a1', 'tok-char': '#f5c2e7',
    'tok-attr': '#f9e2af', 'tok-function': '#89b4fa', 'tok-operator': '#89dceb', 'tok-url': '#89b4fa',
    'tok-regex': '#fab387', 'metrics': '#a6e3a1', 'hint': '#a6adc8', 'tab': '#cdd6f4',
    'status': '#a6adc8', 'error': '#f38ba8', 'warning': '#f9e2af', 'warning-bg': '#313244',
    'warning-border': '#f9e2af', 'accent': '#89b4fa', 'accent-hover': '#b4befe', 'menu': '#313244',
    'menu-hover': '#45475a', 'menu-label': '#a6adc8', 'disabled': '#6c7086', 'option': '#cdd6f4',
    'option-hover': '#f5e0dc', 'cloud': '#a6adc8', 'faint': '#6c7086', 'prune': '#f9e2af',
    'preview': '#cdd6f4', 'preview-bg': '#313244', 'tool-edge': '#89b4fa', 'tool-result': '#a6e3a1',
    'stop': '#f38ba8', 'stop-text': '#f38ba8', 'focus': '#89b4fa', 'prov-bg': '#313244',
    'prov-edge': '#f9e2af', 'prov-text': '#f9e2af', 'diff-del': '#f38ba8', 'diff-add': '#a6e3a1',
    'condense': '#313244', 'comment-bg': '#f9e2af', 'comment-text': '#cdd6f4', 'task-text': '#cdd6f4',
    'task-line': '#45475a'
};
const GRUVBOX_DARK_COLORS = {
    'page': '#282828', 'text': '#ebdbb2', 'surface': '#3c3836', 'inset': '#1d2021',
    'button': '#3c3836', 'button-text': '#ebdbb2', 'border': '#504945', 'heading': '#fbf1c7',
    'title': '#fbf1c7', 'active': '#fbf1c7', 'muted': '#a89984', 'think-border': '#504945',
    'link': '#83a598', 'code-bg': '#1d2021', 'code-fg': '#ebdbb2', 'th-bg': '#3c3836',
    'td-bg': '#282828', 'dock': '#1d2021', 'tok-comment': '#928374', 'tok-punct': '#a89984',
    'tok-keyword': '#fb4934', 'tok-tag': '#fb4934', 'tok-property': '#d65d0e', 'tok-param': '#fabd2f',
    'tok-constant': '#fe8019', 'tok-number': '#fe8019', 'tok-string': '#b8bb26', 'tok-char': '#b8bb26',
    'tok-attr': '#fabd2f', 'tok-function': '#83a598', 'tok-operator': '#ebdbb2', 'tok-url': '#83a598',
    'tok-regex': '#fe8019', 'metrics': '#b8bb26', 'hint': '#a89984', 'tab': '#ebdbb2',
    'status': '#a89984', 'error': '#fb4934', 'warning': '#fabd2f', 'warning-bg': '#3c3836',
    'warning-border': '#fabd2f', 'accent': '#8ec07c', 'accent-hover': '#b8bb26', 'menu': '#3c3836',
    'menu-hover': '#282828', 'menu-label': '#a89984', 'disabled': '#665c54', 'option': '#ebdbb2',
    'option-hover': '#fbf1c7', 'cloud': '#a89984', 'faint': '#665c54', 'prune': '#fabd2f',
    'preview': '#ebdbb2', 'preview-bg': '#3c3836', 'tool-edge': '#83a598', 'tool-result': '#b8bb26',
    'stop': '#fb4934', 'stop-text': '#fb4934', 'focus': '#83a598', 'prov-bg': '#3c3836',
    'prov-edge': '#fabd2f', 'prov-text': '#fabd2f', 'diff-del': '#fb4934', 'diff-add': '#b8bb26',
    'condense': '#3c3836', 'comment-bg': '#fabd2f', 'comment-text': '#ebdbb2', 'task-text': '#ebdbb2',
    'task-line': '#504945'
};
const FALCON_COLORS = {
    'page': '#223333', 'text': '#ddddcc', 'surface': '#334444', 'inset': '#1a2626',
    'button': '#334444', 'button-text': '#ddddcc', 'border': '#556666', 'heading': '#ddddcc',
    'title': '#ddddcc', 'active': '#ddddcc', 'muted': '#888888', 'think-border': '#556666',
    'link': '#7799cc', 'code-bg': '#1a2626', 'code-fg': '#ddddcc', 'th-bg': '#334444',
    'td-bg': '#223333', 'dock': '#1a2626', 'tok-comment': '#888888', 'tok-punct': '#eedd00',
    'tok-keyword': '#7799cc', 'tok-tag': '#aa77aa', 'tok-property': '#aa77aa', 'tok-param': '#ddddcc',
    'tok-constant': '#ffaa33', 'tok-number': '#ffaa33', 'tok-string': '#ddddcc', 'tok-char': '#ffaa33',
    'tok-attr': '#ffaa33', 'tok-function': '#7799cc', 'tok-operator': '#eedd00', 'tok-url': '#7799cc',
    'tok-regex': '#ffaa33', 'metrics': '#88ee33', 'hint': '#888888', 'tab': '#ddddcc',
    'status': '#888888', 'error': '#ff6666', 'warning': '#ffaa33', 'warning-bg': '#334444',
    'warning-border': '#ffaa33', 'accent': '#7799cc', 'accent-hover': '#aa77aa', 'menu': '#334444',
    'menu-hover': '#223333', 'menu-label': '#888888', 'disabled': '#556666', 'option': '#ddddcc',
    'option-hover': '#ffffff', 'cloud': '#888888', 'faint': '#556666', 'prune': '#ffaa33',
    'preview': '#ddddcc', 'preview-bg': '#334444', 'tool-edge': '#7799cc', 'tool-result': '#88ee33',
    'stop': '#ff6666', 'stop-text': '#ff6666', 'focus': '#7799cc', 'prov-bg': '#334444',
    'prov-edge': '#ffaa33', 'prov-text': '#ffaa33', 'diff-del': '#ff6666', 'diff-add': '#88ee33',
    'condense': '#334444', 'comment-bg': '#ffaa33', 'comment-text': '#ddddcc', 'task-text': '#ddddcc',
    'task-line': '#556666'
};
const TOKYO_NIGHT_COLORS = {
    'page': '#1a1b26', 'text': '#a9b1d6', 'surface': '#24283b', 'inset': '#16161e',
    'button': '#24283b', 'button-text': '#a9b1d6', 'border': '#414868', 'heading': '#c0caf5',
    'title': '#c0caf5', 'active': '#c0caf5', 'muted': '#565f89', 'think-border': '#414868',
    'link': '#7aa2f7', 'code-bg': '#16161e', 'code-fg': '#a9b1d6', 'th-bg': '#24283b',
    'td-bg': '#1a1b26', 'dock': '#16161e', 'tok-comment': '#565f89', 'tok-punct': '#bb9af7',
    'tok-keyword': '#bb9af7', 'tok-tag': '#f7768e', 'tok-property': '#ff9e64', 'tok-param': '#bb9af7',
    'tok-constant': '#ff9e64', 'tok-number': '#ff9e64', 'tok-string': '#9ece6a', 'tok-char': '#9ece6a',
    'tok-attr': '#e0af68', 'tok-function': '#7aa2f7', 'tok-operator': '#bb9af7', 'tok-url': '#7aa2f7',
    'tok-regex': '#ff9e64', 'metrics': '#9ece6a', 'hint': '#565f89', 'tab': '#a9b1d6',
    'status': '#565f89', 'error': '#f7768e', 'warning': '#e0af68', 'warning-bg': '#24283b',
    'warning-border': '#e0af68', 'accent': '#7aa2f7', 'accent-hover': '#7dcfff', 'menu': '#24283b',
    'menu-hover': '#1a1b26', 'menu-label': '#565f89', 'disabled': '#414868', 'option': '#a9b1d6',
    'option-hover': '#c0caf5', 'cloud': '#565f89', 'faint': '#414868', 'prune': '#e0af68',
    'preview': '#a9b1d6', 'preview-bg': '#24283b', 'tool-edge': '#7aa2f7', 'tool-result': '#9ece6a',
    'stop': '#f7768e', 'stop-text': '#f7768e', 'focus': '#7aa2f7', 'prov-bg': '#24283b',
    'prov-edge': '#e0af68', 'prov-text': '#e0af68', 'diff-del': '#f7768e', 'diff-add': '#9ece6a',
    'condense': '#24283b', 'comment-bg': '#e0af68', 'comment-text': '#a9b1d6', 'task-text': '#a9b1d6',
    'task-line': '#414868'
};
const OBLIVION_COLORS = {
    'page': '#201f1f', 'text': '#d3d7c1', 'surface': '#2e2e2e', 'inset': '#151515',
    'button': '#2e2e2e', 'button-text': '#d3d7c1', 'border': '#4a4a4a', 'heading': '#eeeeec',
    'title': '#eeeeec', 'active': '#ffffff', 'muted': '#888a85', 'think-border': '#4a4a4a',
    'link': '#508ed8', 'code-bg': '#151515', 'code-fg': '#d3d7c1', 'th-bg': '#2e2e2e',
    'td-bg': '#201f1f', 'dock': '#151515', 'tok-comment': '#30a100', 'tok-punct': '#eeeeec',
    'tok-keyword': '#ffffff', 'tok-tag': '#ad7fa8', 'tok-property': '#ad7fa8', 'tok-param': '#ad7fa8',
    'tok-constant': '#729fcf', 'tok-number': '#edd400', 'tok-string': '#edd400', 'tok-char': '#ce5c00',
    'tok-attr': '#edd400', 'tok-function': '#508ed8', 'tok-operator': '#eeeeec', 'tok-url': '#508ed8',
    'tok-regex': '#edd400', 'metrics': '#30a100', 'hint': '#888a85', 'tab': '#d3d7c1',
    'status': '#888a85', 'error': '#e85848', 'warning': '#edd400', 'warning-bg': '#2e2e2e',
    'warning-border': '#edd400', 'accent': '#508ed8', 'accent-hover': '#729fcf', 'menu': '#2e2e2e',
    'menu-hover': '#201f1f', 'menu-label': '#888a85', 'disabled': '#4a4a4a', 'option': '#d3d7c1',
    'option-hover': '#eeeeec', 'cloud': '#888a85', 'faint': '#4a4a4a', 'prune': '#edd400',
    'preview': '#d3d7c1', 'preview-bg': '#2e2e2e', 'tool-edge': '#508ed8', 'tool-result': '#30a100',
    'stop': '#e85848', 'stop-text': '#e85848', 'focus': '#508ed8', 'prov-bg': '#2e2e2e',
    'prov-edge': '#edd400', 'prov-text': '#edd400', 'diff-del': '#e85848', 'diff-add': '#30a100',
    'condense': '#2e2e2e', 'comment-bg': '#edd400', 'comment-text': '#d3d7c1', 'task-text': '#d3d7c1',
    'task-line': '#4a4a4a'
};
const NORD_COLORS = {
    'page': '#2e3440', 'text': '#d8dee9', 'surface': '#3b4252', 'inset': '#242933',
    'button': '#3b4252', 'button-text': '#d8dee9', 'border': '#4c566a', 'heading': '#eceff4',
    'title': '#eceff4', 'active': '#eceff4', 'muted': '#616e88', 'think-border': '#4c566a',
    'link': '#88c0d0', 'code-bg': '#242933', 'code-fg': '#d8dee9', 'th-bg': '#3b4252',
    'td-bg': '#2e3440', 'dock': '#242933', 'tok-comment': '#616e88', 'tok-punct': '#81a1c1',
    'tok-keyword': '#81a1c1', 'tok-tag': '#bf616a', 'tok-property': '#d08770', 'tok-param': '#e5e9f0',
    'tok-constant': '#88c0d0', 'tok-number': '#b48ead', 'tok-string': '#a3be8c', 'tok-char': '#ebcb8b',
    'tok-attr': '#ebcb8b', 'tok-function': '#88c0d0', 'tok-operator': '#81a1c1', 'tok-url': '#88c0d0',
    'tok-regex': '#d08770', 'metrics': '#a3be8c', 'hint': '#616e88', 'tab': '#d8dee9',
    'status': '#616e88', 'error': '#bf616a', 'warning': '#ebcb8b', 'warning-bg': '#3b4252',
    'warning-border': '#ebcb8b', 'accent': '#88c0d0', 'accent-hover': '#81a1c1', 'menu': '#3b4252',
    'menu-hover': '#2e3440', 'menu-label': '#616e88', 'disabled': '#4c566a', 'option': '#d8dee9',
    'option-hover': '#eceff4', 'cloud': '#616e88', 'faint': '#4c566a', 'prune': '#ebcb8b',
    'preview': '#d8dee9', 'preview-bg': '#3b4252', 'tool-edge': '#81a1c1', 'tool-result': '#a3be8c',
    'stop': '#bf616a', 'stop-text': '#bf616a', 'focus': '#81a1c1', 'prov-bg': '#3b4252',
    'prov-edge': '#ebcb8b', 'prov-text': '#ebcb8b', 'diff-del': '#bf616a', 'diff-add': '#a3be8c',
    'condense': '#3b4252', 'comment-bg': '#ebcb8b', 'comment-text': '#d8dee9', 'task-text': '#d8dee9',
    'task-line': '#4c566a'
};
const BUILTIN_THEME_COLOR_MAP = {
    'solarized-dark': SOLARIZED_DARK_COLORS,
    'catppuccin-mocha': CATPPUCCIN_MOCHA_COLORS,
    'gruvbox-dark': GRUVBOX_DARK_COLORS,
    'falcon': FALCON_COLORS,
    'tokyo-night': TOKYO_NIGHT_COLORS,
    'oblivion': OBLIVION_COLORS,
    'nord': NORD_COLORS
};
function themeBuiltin(id) {
    if (BUILTIN_THEME_COLOR_MAP[id]) return fillThemeColors(BUILTIN_THEME_COLOR_MAP[id]);
    const column = id === 'dark' ? 4 : 3;
    const colors = {};
    for (let i = 0; i < THEME_FIELDS.length; i++) colors[THEME_FIELDS[i][1]] = THEME_FIELDS[i][column];
    return colors;
}
function fillThemeColors(partial, base) {
    const colors = base || themeBuiltin('blue-gold');
    if (!partial || typeof partial !== 'object') return colors;
    for (let i = 0; i < THEME_FIELDS.length; i++) {
        const hex = normalizeHex(partial[THEME_FIELDS[i][1]]);
        if (hex) colors[THEME_FIELDS[i][1]] = hex;
    }
    return colors;
}
function themeColorsEqual(a, b) {
    if (!a || !b) return false;
    for (let i = 0; i < THEME_FIELDS.length; i++) {
        if (a[THEME_FIELDS[i][1]] !== b[THEME_FIELDS[i][1]]) return false;
    }
    return true;
}
function themeStorageGet(key) {
    try {
        if (typeof localStorage === 'undefined' || !localStorage.getItem) return null;
        return localStorage.getItem(key);
    } catch (e) {
        return null;
    }
}
function themeStorageSet(key, value) {
    try {
        if (typeof localStorage === 'undefined' || !localStorage.setItem) return;
        localStorage.setItem(key, value);
    } catch (e) {}
}
function canonicalThemeId(id) {
    if (id === 'current' || id === 'blue-gold') return 'blue-gold';
    if (id === 'dark' || id === 'solarized-dark' || id === 'catppuccin-mocha' || id === 'gruvbox-dark' || id === 'falcon' || id === 'tokyo-night' || id === 'oblivion' || id === 'nord' || id === 'custom') return id;
    if (typeof id === 'string' && /^p[a-z0-9]+$/.test(id)) return id;
    return '';
}
function storedThemeId() {
    const id = canonicalThemeId(themeStorageGet(HIGHLIGHT_STORE_KEY));
    // Dark mode is the harness's resting look: a browser that never chose
    // a theme opens on it, the way it opens on the blue-and-gold one
    // only by an explicit stored choice.
    return id || 'dark';
}
function hasStoredColors() {
    const raw = themeStorageGet(THEME_COLOR_KEY);
    if (!raw) return false;
    try {
        const parsed = JSON.parse(raw);
        return !!(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
    } catch (e) {
        return false;
    }
}
function loadStoredColors() {
    try {
        const partial = JSON.parse(themeStorageGet(THEME_COLOR_KEY) || 'null');
        // Backfill missing fields from the ACTIVE preset, not always the
        // built-in default: a browser holding colors saved before a new
        // field existed heals to its own preset's value for that field,
        // and keeps matching that preset instead of drifting to custom.
        // A custom working set has no preset to heal from, so it keeps
        // the resting defaults for anything it never stored.
        const stored = storedThemeId();
        const base = stored === 'custom'
            ? themeBuiltin('dark')
            : colorsForId(stored) || themeBuiltin('dark');
        return fillThemeColors(partial, base);
    } catch (e) {
        return themeBuiltin('dark');
    }
}
function loadUserPresets() {
    try {
        const parsed = JSON.parse(themeStorageGet(THEME_PRESET_KEY) || '[]');
        if (!Array.isArray(parsed)) return [];
        const out = [];
        for (let i = 0; i < parsed.length && out.length < THEME_PRESET_LIMIT; i++) {
            const p = parsed[i];
            if (!p || typeof p.id !== 'string' || !/^p[a-z0-9]+$/.test(p.id)) continue;
            if (typeof p.name !== 'string' || !p.name.trim()) continue;
            out.push({ id: p.id, name: p.name.trim().slice(0, 40), colors: fillThemeColors(p.colors) });
        }
        return out;
    } catch (e) {
        return [];
    }
}
function saveUserPresets(presets) {
    themeStorageSet(THEME_PRESET_KEY, JSON.stringify(presets.map(p => ({ id: p.id, name: p.name, colors: p.colors }))));
}
function colorsForId(id) {
    const canon = canonicalThemeId(id);
    if (canon === 'blue-gold') return themeBuiltin('blue-gold');
    if (canon === 'dark') return themeBuiltin('dark');
    if (canon === 'solarized-dark') return themeBuiltin('solarized-dark');
    if (canon === 'catppuccin-mocha') return themeBuiltin('catppuccin-mocha');
    if (canon === 'gruvbox-dark') return themeBuiltin('gruvbox-dark');
    if (canon === 'falcon') return themeBuiltin('falcon');
    if (canon === 'tokyo-night') return themeBuiltin('tokyo-night');
    if (canon === 'oblivion') return themeBuiltin('oblivion');
    if (canon === 'nord') return themeBuiltin('nord');
    if (canon === 'custom') return hasStoredColors() ? loadStoredColors() : themeBuiltin('dark');
    if (!canon) return null;
    const presets = loadUserPresets();
    // Healed on read: a preset saved before a theme field existed gets
    // the blue-and-gold default for it, so applying an old preset still
    // paints every field and still matches itself.
    for (let i = 0; i < presets.length; i++) if (presets[i].id === canon) return fillThemeColors(presets[i].colors);
    return null;
}
function loadThemeColors() {
    if (hasStoredColors()) return loadStoredColors();
    return colorsForId(storedThemeId()) || themeBuiltin('dark');
}
function themeColor(key) {
    const colors = loadThemeColors();
    return colors[key] || '';
}
function matchingPresetId(colors) {
    const current = storedThemeId();
    if (current !== 'custom') {
        const chosen = colorsForId(current);
        if (chosen && themeColorsEqual(colors, chosen)) return current;
    }
    if (themeColorsEqual(colors, themeBuiltin('blue-gold'))) return 'blue-gold';
    if (themeColorsEqual(colors, themeBuiltin('dark'))) return 'dark';
    if (themeColorsEqual(colors, themeBuiltin('solarized-dark'))) return 'solarized-dark';
    if (themeColorsEqual(colors, themeBuiltin('catppuccin-mocha'))) return 'catppuccin-mocha';
    if (themeColorsEqual(colors, themeBuiltin('gruvbox-dark'))) return 'gruvbox-dark';
    if (themeColorsEqual(colors, themeBuiltin('falcon'))) return 'falcon';
    if (themeColorsEqual(colors, themeBuiltin('tokyo-night'))) return 'tokyo-night';
    if (themeColorsEqual(colors, themeBuiltin('oblivion'))) return 'oblivion';
    if (themeColorsEqual(colors, themeBuiltin('nord'))) return 'nord';
    const presets = loadUserPresets();
    for (let i = 0; i < presets.length; i++) {
        if (themeColorsEqual(colors, presets[i].colors)) return presets[i].id;
    }
    return '';
}
function paintTheme(colors) {
    try {
        const root = typeof document !== 'undefined' ? document.documentElement : null;
        if (!root) return;
        if (root.style && typeof root.style.setProperty === 'function') {
            for (let i = 0; i < THEME_FIELDS.length; i++) {
                root.style.setProperty('--h-' + THEME_FIELDS[i][1], colors[THEME_FIELDS[i][1]]);
            }
        }
        // Legacy dark rules are keyed off this attribute. Variables are the
        // live theme, so the attribute must not keep the old hexes on top.
        if (typeof root.removeAttribute === 'function') root.removeAttribute('data-highlight');
    } catch (e) {}
}
function persistTheme(id, colors) {
    themeStorageSet(HIGHLIGHT_STORE_KEY, id);
    themeStorageSet(THEME_COLOR_KEY, JSON.stringify(colors));
}
function highlightTheme() {
    return storedThemeId();
}
function listThemeChoices() {
    const choices = [
        { id: 'blue-gold', name: 'Blue and gold', builtin: true },
        { id: 'dark', name: 'Dark mode', builtin: true },
        { id: 'solarized-dark', name: 'Solarized dark', builtin: true },
        { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', builtin: true },
        { id: 'gruvbox-dark', name: 'gruvbox Dark', builtin: true },
        { id: 'falcon', name: 'Falcon', builtin: true },
        { id: 'tokyo-night', name: 'Tokyo Night', builtin: true },
        { id: 'oblivion', name: 'Oblivion', builtin: true },
        { id: 'nord', name: 'Nord', builtin: true }
    ];
    const presets = loadUserPresets();
    for (let i = 0; i < presets.length; i++) {
        choices.push({ id: presets[i].id, name: presets[i].name, builtin: false });
    }
    return choices;
}
// mode omitted: reapply the stored working colors. A named id loads that
// preset and replaces the working colors.
function applyHighlightTheme(mode) {
    const explicit = canonicalThemeId(mode);
    let colors;
    if (!explicit && hasStoredColors()) colors = loadStoredColors();
    else colors = colorsForId(explicit || storedThemeId()) || themeBuiltin('dark');
    const id = matchingPresetId(colors) || 'custom';
    paintTheme(colors);
    persistTheme(id, colors);
    return id;
}
function setThemeColor(key, value) {
    let known = false;
    for (let i = 0; i < THEME_FIELDS.length; i++) if (THEME_FIELDS[i][1] === key) known = true;
    const hex = normalizeHex(value);
    if (!known || !hex) return '';
    const colors = loadThemeColors();
    colors[key] = hex;
    const id = matchingPresetId(colors) || 'custom';
    paintTheme(colors);
    persistTheme(id, colors);
    return hex;
}
function reservedThemeName(name) {
    const trimmed = String(name || '').trim().replace(/\s+/g, ' ');
    const lower = trimmed.toLowerCase();
    return lower === 'blue and gold' || lower === 'dark mode' || lower === 'solarized dark'
        || lower === 'catppuccin mocha' || lower === 'gruvbox dark' || lower === 'falcon'
        || lower === 'tokyo night' || lower === 'oblivion' || lower === 'nord';
}
function themePresetError(name) {
    const trimmed = String(name || '').trim().replace(/\s+/g, ' ');
    if (!trimmed) return 'Enter a preset name.';
    if (trimmed.length > 40) return 'Use 40 characters or fewer.';
    if (reservedThemeName(trimmed)) return 'Blue and gold, Dark mode, and Solarized dark keep their names.';
    const presets = loadUserPresets();
    let exists = false;
    for (let i = 0; i < presets.length; i++) if (presets[i].name.toLowerCase() === trimmed.toLowerCase()) exists = true;
    if (!exists && presets.length >= THEME_PRESET_LIMIT) return 'The preset list holds 24 saved themes.';
    return '';
}
// Saves the working colors. The same name updates that preset. Returns the
// preset id, or '' when the name cannot be saved.
function saveThemePreset(name) {
    if (themePresetError(name)) return '';
    const trimmed = String(name).trim().replace(/\s+/g, ' ').slice(0, 40);
    const colors = loadThemeColors();
    const presets = loadUserPresets();
    let id = '';
    for (let i = 0; i < presets.length; i++) {
        if (presets[i].name.toLowerCase() === trimmed.toLowerCase()) {
            presets[i].name = trimmed;
            presets[i].colors = colors;
            id = presets[i].id;
        }
    }
    if (!id) {
        id = 'p' + Date.now().toString(36) + presets.length.toString(36);
        presets.push({ id: id, name: trimmed, colors: colors });
    }
    saveUserPresets(presets);
    paintTheme(colors);
    persistTheme(id, colors);
    return id;
}
function deleteThemePreset(id) {
    if (id === 'blue-gold' || id === 'dark' || id === 'solarized-dark' || id === 'catppuccin-mocha' || id === 'gruvbox-dark' || id === 'falcon' || id === 'tokyo-night' || id === 'oblivion' || id === 'nord' || id === 'current' || id === 'custom') return false;
    if (typeof id !== 'string' || !/^p[a-z0-9]+$/.test(id)) return false;
    const presets = loadUserPresets();
    const next = [];
    for (let i = 0; i < presets.length; i++) if (presets[i].id !== id) next.push(presets[i]);
    if (next.length === presets.length) return false;
    saveUserPresets(next);
    // Deleting the active preset returns to the resting look.
    if (storedThemeId() === id) applyHighlightTheme('dark');
    return true;
}
// Archive CSS is a standalone copy of the page rules. Blue and gold is
// already in that sheet. Anything else appends later so it wins.
function archiveDarkHighlightCss() {
    const colors = loadThemeColors();
    if (themeColorsEqual(colors, themeBuiltin('blue-gold'))) return '';
    const c = colors;
    return 'body{background:' + c.page + ';color:' + c.text + '}'
        + 'pre{background:' + c.surface + ';color:' + c.text + '}'
        + '.round h3{color:' + c.heading + '}'
        + '.done{color:' + c.title + '}'
        + 'a,details summary{color:' + c.link + '}'
        + '.rendered pre,.rendered code{background:' + c['code-bg'] + ';color:' + c['code-fg'] + '}'
        + '.rendered pre code{display:block;padding:0;border-radius:0;background:transparent;color:inherit}'
        + '.rendered .token.comment,.rendered .token.prolog,.rendered .token.doctype,.rendered .token.cdata{color:' + c['tok-comment'] + ';font-style:italic}'
        + '.rendered .token.punctuation{color:' + c['tok-punct'] + '}'
        + '.rendered .token.keyword,.rendered .token.control,.rendered .token.atrule{color:' + c['tok-keyword'] + '}'
        + '.rendered .token.tag,.rendered .token.deleted{color:' + c['tok-tag'] + '}'
        + '.rendered .token.property{color:' + c['tok-property'] + '}'
        + '.rendered .token.parameter{color:' + c['tok-param'] + '}'
        + '.rendered .token.constant,.rendered .token.symbol{color:' + c['tok-constant'] + '}'
        + '.rendered .token.number,.rendered .token.boolean{color:' + c['tok-number'] + '}'
        + '.rendered .token.string,.rendered .token.selector,.rendered .token.attr-name,.rendered .token.builtin,.rendered .token.inserted{color:' + c['tok-string'] + '}'
        + '.rendered .token.char{color:' + c['tok-char'] + '}'
        + '.rendered .token.attr-value{color:' + c['tok-attr'] + '}'
        + '.rendered .token.function,.rendered .token.class-name{color:' + c['tok-function'] + '}'
        + '.rendered .token.operator,.rendered .token.entity,.rendered .token.variable{color:' + c['tok-operator'] + '}'
        + '.rendered .token.url{color:' + c['tok-url'] + '}'
        + '.rendered .token.regex,.rendered .token.important{color:' + c['tok-regex'] + '}'
        + '.user-comment{color:' + c['comment-text'] + ';background:color-mix(in srgb,' + c['comment-bg'] + ' 42%,transparent)}';
}
// ---------- request authentication ----------
// The server requires the per-launch token on every request (see
// src/auth.rs): it refuses anything that does not carry it, so another
// local process cannot drive the harness or approve its tool calls.
// The token arrives in the meta tag the server renders into this page.
const HARNESS_TOKEN = (function () {
    try {
        const meta = document.querySelector('meta[name="harness-token"]');
        return meta ? (meta.getAttribute('content') || '') : '';
    } catch (e) { return ''; }
})();
function apiFetch(url, options) {
    options = options || {};
    const headers = Object.assign({}, options.headers || {});
    if (HARNESS_TOKEN) headers['X-Harness-Token'] = HARNESS_TOKEN;
    options.headers = headers;
    return fetch(url, options);
}
let sessions = [];
let activeSid = null;
let runningSid = null;
let seq = 0;
let timerId = null;
let t0 = 0;
let storeEnabled = true;
// True once a session holds content worth keeping that hasn't been
// exported yet (any download resets it). Drives the "new session"
// confirmation: no dialog when there's nothing unexported to lose.
let exportDirty = false;

function fmtMs(ms) { return ms >= 1000 ? (ms/1000).toFixed(2)+'s' : Math.round(ms)+'ms'; }
// Raw-capture heading. Search and shell transcripts are their own
// originals; everything else fetched from the web stays FETCH ORIGINAL.
function toolTaskPhrase(args) {
    if (!args || typeof args.task !== 'string') return '';
    return args.task.trim();
}
function toolHoverText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}
function toolFileName(path) {
    const text = toolHoverText(path);
    if (!text) return '';
    const parts = text.split(/[/\\]/);
    return parts[parts.length - 1] || text;
}
// Hover lines for a condensed tool count. run_cmd keeps its task.
// Search, fetch, PDF, and questions use the field that call actually has.
function toolHoverPhrases(name, args) {
    const tool = name == null ? '' : String(name);
    if (!args || typeof args !== 'object') return [];
    if (tool === 'run_cmd') {
        const task = toolHoverText(toolTaskPhrase(args));
        return task ? [task] : [];
    }
    if (tool === 'web_fetch') {
        const url = toolHoverText(args.url);
        return url ? [url] : [];
    }
    if (tool === 'read_pdf' || tool === 'pdf_reader') {
        const file = toolFileName(args.path);
        return file ? [file] : [];
    }
    if (tool === 'ask_user') {
        const lines = [];
        const questions = Array.isArray(args.questions) ? args.questions : [];
        for (let i = 0; i < questions.length; i++) {
            const text = toolHoverText(questions[i] && questions[i].question);
            if (text) lines.push(text);
        }
        return lines;
    }
    if (tool === 'web_search' || tool === 'godot_docs_search' || /search/.test(tool)) {
        const query = toolHoverText(args.query);
        return query ? [query] : [];
    }
    const task = toolHoverText(toolTaskPhrase(args));
    return task ? [task] : [];
}
function roundMetaLines(metrics, data) {
    const lines = [];
    if (metrics && typeof metrics === 'object') {
        if (metrics.model) lines.push('model: ' + metrics.model);
        if (metrics.prompt_tokens != null || metrics.completion_tokens != null) {
            let tokens = 'tokens: prompt ' + (metrics.prompt_tokens || 0) + ' / completion ' + (metrics.completion_tokens || 0);
            if (metrics.reasoning_tokens) tokens += ' / reasoning ' + metrics.reasoning_tokens;
            lines.push(tokens);
        }
        if (metrics.cached_tokens) lines.push('cached: ' + metrics.cached_tokens);
        if (metrics.reasoning_effort) lines.push('effort: ' + metrics.reasoning_effort);
        if (typeof metrics.cost_usd === 'number' && metrics.cost_usd > 0) {
            const digits = metrics.cost_usd >= 0.01 ? 4 : 6;
            lines.push('cost: $' + metrics.cost_usd.toFixed(digits));
        }
        if (typeof metrics.total_ms === 'number') lines.push('total: ' + metrics.total_ms.toFixed(1) + 'ms');
        if (typeof metrics.load_ms === 'number') lines.push('load: ' + metrics.load_ms.toFixed(1) + 'ms');
        if (typeof metrics.prompt_eval_ms === 'number') lines.push('prompt_eval: ' + metrics.prompt_eval_ms.toFixed(1) + 'ms');
        if (typeof metrics.eval_ms === 'number') lines.push('eval: ' + metrics.eval_ms.toFixed(1) + 'ms');
        if (typeof metrics.tps === 'number') lines.push(metrics.tps.toFixed(1) + ' tok/s');
    }
    if (data && typeof data === 'object') {
        const totals = data.totals || {};
        const prompt = totals.prompt || 0;
        const completion = totals.completion || 0;
        if (prompt || completion) lines.push('session tokens: ' + prompt + ' prompt + ' + completion + ' completion');
        if (data.wallMs) lines.push('wall: ' + (typeof fmtMs === 'function' ? fmtMs(data.wallMs) : (data.wallMs + 'ms')));
        const done = data.doneInfo;
        if (done && typeof done === 'object') {
            if (done.rounds != null) lines.push('rounds: ' + done.rounds);
            if (done.max_rounds_hit) lines.push('reached max tool rounds');
        }
    }
    return lines;
}
// What the approval dialog and the transcript say the shell is allowed
// to run for. Omitted, "none", and "default" mean no time limit.
// Unrecognized text is returned as written so the person can see it
// before accepting.
// Display-only shell prettifier: splits a command at its top-level
// connectors — && || ; | outside quotes and backslash escapes — so a
// long concatenated command can be read. The parts join back to the
// input byte for byte; only the displayed layout differs (whitespace at
// the breaks). The submitted command, the Edit Command box, and every
// copy/curate path keep the raw text.
function shellCommandParts(command) {
    const text = String(command == null ? '' : command);
    const parts = [];
    let start = 0;
    let connector = '';
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote === "'") { if (ch === "'") quote = null; continue; }
        if (ch === '\\') { i += 1; continue; }
        if (quote === '"') { if (ch === '"') quote = null; continue; }
        if (ch === "'" || ch === '"') { quote = ch; continue; }
        let sep = '';
        if (ch === '&' && text[i + 1] === '&') sep = '&&';
        else if (ch === '|' && text[i + 1] === '|') sep = '||';
        else if (ch === '|') sep = '|';
        else if (ch === ';') sep = ';';
        if (!sep) continue;
        parts.push({ connector, text: text.slice(start, i) });
        connector = sep;
        start = i + sep.length;
        i += sep.length - 1;
    }
    parts.push({ connector, text: text.slice(start) });
    return parts;
}
function prettyShellForDisplay(command) {
    const parts = shellCommandParts(command);
    let out = '';
    for (let i = 0; i < parts.length; i++) {
        const piece = parts[i].text.trim();
        if (i === 0) out = piece;
        else out += '\n  ' + parts[i].connector + ' ' + piece;
    }
    return out;
}
// A display-only shell view: the pretty text in a Prism bash block by
// default with a raw/pretty toggle beside it. The raw text is the copy
// source and stays byte-identical; the pretty block is marked so
// copy/curate text extraction drops it (rawBodyText strips .shell-pretty
// and .view-toggle, the same treatment rendered markdown gets).
function paintShellView(container, rawText, prettyText) {
    container.textContent = '';
    const raw = document.createElement('pre');
    raw.className = 'shell-raw';
    // The raw block keeps the house comment-tag highlighting and is the
    // copy/curate source.
    if (typeof fillCommented === 'function') fillCommented(raw, rawText);
    else raw.textContent = rawText;
    const pretty = document.createElement('pre');
    pretty.className = 'shell-pretty';
    const code = document.createElement('code');
    code.className = 'language-bash';
    code.textContent = typeof safeDisplay === 'function' ? safeDisplay(prettyText) : prettyText;
    pretty.appendChild(code);
    const toggle = document.createElement('button');
    toggle.className = 'view-toggle';
    toggle.type = 'button';
    let showing = 'pretty';
    const paint = () => {
        raw.style.display = showing === 'raw' ? '' : 'none';
        pretty.style.display = showing === 'raw' ? 'none' : '';
        toggle.textContent = showing === 'raw' ? 'pretty command' : 'raw command';
        if (showing !== 'raw' && typeof highlightRendered === 'function') {
            highlightRendered(pretty);
        }
    };
    toggle.onclick = () => { showing = showing === 'raw' ? 'pretty' : 'raw'; paint(); };
    container.appendChild(toggle);
    container.appendChild(pretty);
    container.appendChild(raw);
    paint();
}
function runCmdTimeoutPhrase(args) {
    if (!args || typeof args.command !== 'string') return '';
    const raw = args.timeout == null ? '' : String(args.timeout).trim().toLowerCase();
    if (raw === '' || raw === 'none' || raw === 'default') return 'none';
    if (raw === '30s') return '30s';
    if (raw === '20m') return '20m';
    return String(args.timeout).trim();
}
function hidSuffix(hid) {
    const n = Number(hid);
    if (!n || n < 1) return '';
    return ' HID: ' + Math.floor(n);
}
function withHid(text, hid) {
    const suffix = hidSuffix(hid);
    if (!suffix) return text == null ? '' : String(text);
    const s = text == null ? '' : String(text);
    const nl = s.indexOf('\n');
    if (nl < 0) return s + suffix;
    return s.slice(0, nl) + suffix + s.slice(nl);
}
function formatToolCallText(name, args, pretty) {
    let rendered = '';
    try { rendered = JSON.stringify(args, null, 2); } catch (e) { rendered = String(args); }
    let text = '▶ TOOL CALL → ' + name;
    const task = toolTaskPhrase(args);
    if (task) text += '\nTask: ' + task;
    if ((name === 'run_cmd' || name === 'run_sudo_cmd') && typeof runCmdTimeoutPhrase === 'function') {
        const limit = name === 'run_sudo_cmd' && typeof sudoTimeoutPhrase === 'function'
            ? sudoTimeoutPhrase(args)
            : runCmdTimeoutPhrase(args);
        if (limit === '30s') text += '\nTimeout: 30s';
        else if (limit === '20m') text += '\nTimeout: 20 minutes';
        else if (limit === 'none') text += '\nTimeout: none';
        else if (limit) text += '\nTimeout: ' + limit;
    }
    // Pretty is display-only: the raw two-argument call is byte-for-byte
    // the copy/curate text; the pretty variant adds a readable command
    // block above the raw arguments for the on-screen window.
    if (pretty && args && typeof args.command === 'string') {
        text += '\ncommand:\n' + prettyShellForDisplay(args.command) + '\n';
    }
    return text + '\nArguments: ' + rendered;
}
function sudoTimeoutPhrase(args) {
    if (!args || typeof args.command !== 'string') return '';
    const raw = args.timeout == null ? '' : String(args.timeout).trim().toLowerCase();
    if (raw === '' || raw === 'default' || raw === '30s') return '30s';
    if (raw === 'none') return 'none';
    if (raw === '20m') return '20m';
    return String(args.timeout).trim();
}
function originalPreviewLabel(name) {
    if (name === 'read_pdf') return 'EXTRACT ORIGINAL';
    if (name === 'web_search' || name === 'rag_search') return 'SEARCH ORIGINAL';
    if (name === 'run_cmd') return 'COMMAND OUTPUT ORIGINAL';
    if (name === 'run_sudo_cmd') return 'ROOT OUTPUT ORIGINAL';
    return 'FETCH ORIGINAL';
}
// A web_fetch tool_preview is the Execution JSON (stdout, stderr, raw body).
// Plain captures and other tools stay plain text.
function parseFetchCapture(output) {
    if (typeof output !== 'string') return null;
    const trimmed = output.trim();
    if (!trimmed.startsWith('{')) return null;
    let value;
    try { value = JSON.parse(output); } catch (e) { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.stdout !== 'string') return null;
    return {
        stdout: value.stdout,
        stderr: typeof value.stderr === 'string' ? value.stderr : '',
        rawBody: typeof value.raw_body === 'string' ? value.raw_body : ''
    };
}
// Continued context keeps the captured page text. Stderr and the HTTP body
// stay in the transcript for the diagnostic tabs.
function previewContextText(preview) {
    if (preview && preview.name === 'web_fetch') {
        const cap = parseFetchCapture(preview.output);
        if (cap) return cap.stdout;
    }
    return preview && preview.output != null ? String(preview.output) : '';
}
function webFetchStderrAt(previews, index) {
    const list = (previews || []).filter(item => item && item.name === 'web_fetch');
    const preview = list[index];
    if (!preview) return '';
    const cap = parseFetchCapture(preview.output);
    if (!cap || !String(cap.stderr).trim()) return '';
    return cap.stderr;
}
function mountToolPanes(el, heading, panes) {
    const body = panes && panes.length ? panes : [{ label: 'Output', text: '' }];
    if (body.length < 2) {
        fillCommented(el, heading + '\n' + body[0].text);
        return;
    }
    el.textContent = '';
    const head = document.createElement('div');
    head.className = 'tool-window-head';
    head.textContent = heading;
    el.appendChild(head);
    const bar = document.createElement('div');
    bar.className = 'sub-tabs tool-tabs';
    bar.setAttribute('role', 'tablist');
    const blocks = [];
    body.forEach((pane, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sub-tab' + (i === 0 ? ' sub-tab-active' : '');
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
        btn.textContent = pane.label;
        const pre = document.createElement('pre');
        pre.className = 'tool-tab-body';
        fillCommented(pre, pane.text);
        pre.style.display = i === 0 ? '' : 'none';
        btn.onclick = () => {
            blocks.forEach((block, j) => {
                const on = j === i;
                block.style.display = on ? '' : 'none';
                const tab = bar.children[j];
                if (!tab) return;
                tab.className = 'sub-tab' + (on ? ' sub-tab-active' : '');
                tab.setAttribute('aria-selected', on ? 'true' : 'false');
            });
        };
        bar.appendChild(btn);
        blocks.push(pre);
    });
    el.appendChild(bar);
    blocks.forEach(block => el.appendChild(block));
}
function renderWebFetchPreview(el, show, item, heading) {
    if (!heading) heading = '▶ ' + originalPreviewLabel(item.name) + ' (before review, ' + item.duration_ms + ' ms)';
    const cap = parseFetchCapture(item.output);
    if (!cap) {
        fillCommented(el, heading + '\n' + show(item.output));
        return;
    }
    const panes = [{ label: 'Captured text', text: show(cap.stdout) }];
    if (String(cap.stderr).trim()) panes.push({ label: 'stderr', text: show(cap.stderr) });
    if (cap.rawBody) panes.push({ label: 'Original HTML', text: show(cap.rawBody) });
    mountToolPanes(el, heading, panes);
}
function renderWebFetchResult(el, show, item, stderr) {
    const heading = typeof withHid === 'function'
        ? withHid('▶ TOOL RESULT (' + item.duration_ms + ' ms)', item && item.hid)
        : ('▶ TOOL RESULT (' + item.duration_ms + ' ms)');
    const panes = [{ label: 'Output', text: show(item.output) }];
    if (stderr && String(stderr).trim()) panes.push({ label: 'stderr', text: show(stderr) });
    mountToolPanes(el, heading, panes);
}
// The launch comment marker is 12 hex characters. Anything else is left
// untouched so an older transcript keeps the words it was stored with.
function validCommentTag(tag) {
    return typeof tag === 'string' && /^[0-9a-fA-F]{12}$/.test(tag) ? tag.toLowerCase() : '';
}
function commentTagOf(s) {
    // A session that already recorded its marker, including an empty one
    // from an older run, keeps that marker. Only a session that has not
    // been told yet falls back to this launch's tag.
    if (s && Object.prototype.hasOwnProperty.call(s, 'commentTag')) return validCommentTag(s.commentTag);
    if (typeof cachedConfig !== 'undefined' && cachedConfig) return validCommentTag(cachedConfig.comment_tag);
    return '';
}
function maskCommentTags(text, tag) {
    const key = validCommentTag(tag);
    const value = text == null ? '' : String(text);
    if (!key) return value;
    return value.split('<' + key + '>').join('<user_comment>').split('</' + key + '>').join('</user_comment>');
}
function displaySessionText(s, text) {
    return maskCommentTags(text, commentTagOf(s));
}
// A comment can open on one line and close on a later line. state.open
// carries that across the lines of one painted block.
function commentParts(text, state) {
    const value = text == null ? '' : String(text);
    const openTag = '<user_comment>';
    const closeTag = '</user_comment>';
    const parts = [];
    let i = 0;
    let open = !!(state && state.open);
    while (i < value.length) {
        if (open) {
            const close = value.indexOf(closeTag, i);
            if (close < 0) {
                parts.push({ comment: true, text: value.slice(i) });
                i = value.length;
            } else {
                const end = close + closeTag.length;
                parts.push({ comment: true, text: value.slice(i, end) });
                i = end;
                open = false;
            }
        } else {
            const start = value.indexOf(openTag, i);
            if (start < 0) {
                parts.push({ comment: false, text: value.slice(i) });
                i = value.length;
            } else {
                if (start > i) parts.push({ comment: false, text: value.slice(i, start) });
                i = start;
                open = true;
            }
        }
    }
    if (state) state.open = open;
    return parts;
}
function appendPlainPiece(parent, text) {
    if (!text) return;
    if (typeof document.createTextNode === 'function') {
        parent.appendChild(document.createTextNode(text));
        return;
    }
    const span = document.createElement('span');
    span.textContent = text;
    parent.appendChild(span);
}
function paintCommentParts(parent, parts) {
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part.text) continue;
        if (!part.comment) {
            appendPlainPiece(parent, part.text);
            continue;
        }
        const mark = document.createElement('span');
        mark.className = 'user-comment';
        mark.textContent = part.text;
        parent.appendChild(mark);
    }
}
function fillCommented(el, text) {
    if (!el) return;
    const value = text == null ? '' : String(text);
    const parts = commentParts(value, { open: false });
    if (parts.length === 1 && !parts[0].comment) {
        el.textContent = value;
        return;
    }
    el.textContent = '';
    paintCommentParts(el, parts);
}
// Thinking and the response stay plain text. A model often prints an
// opening comment tag with no close, and a highlight would wash the rest
// of that block. The tags are still translated before this is called.
function fillPlain(el, text) {
    if (!el) return;
    el.textContent = text == null ? '' : String(text);
}
function setStatus(text) { document.getElementById('status').textContent = text; }
// Keyboard use inside a modal overlay: Tab cycles among the overlay's
// focusable controls instead of landing behind it, and Escape runs the
// caller's cancel action when one is safe to provide. Approval dialogs
// pass no Escape action on purpose — nothing about an approval is
// decided by a keystroke.
function trapOverlayFocus(overlay, onEscape) {
    if (!overlay || typeof overlay.addEventListener !== 'function') return;
    overlay.addEventListener('keydown', (event) => {
        if (!event) return;
        if (event.key === 'Escape' && typeof onEscape === 'function') {
            event.preventDefault();
            onEscape();
            return;
        }
        if (event.key !== 'Tab') return;
        let focusable = [];
        if (typeof overlay.querySelectorAll === 'function') {
            focusable = Array.prototype.slice.call(
                overlay.querySelectorAll('button, input, textarea, select, [tabindex]')
            ).filter(el => el && el.style && el.style.display !== 'none' && !el.disabled);
        }
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = typeof document.activeElement !== 'undefined' ? document.activeElement : null;
        const inside = active && typeof overlay.contains === 'function' ? overlay.contains(active) : false;
        if (!event.shiftKey && (active === last || !inside)) {
            event.preventDefault();
            if (typeof first.focus === 'function') first.focus();
        } else if (event.shiftKey && (active === first || !inside)) {
            event.preventDefault();
            if (typeof last.focus === 'function') last.focus();
        }
    });
}
function getSession(sid) { return sessions.find(s => s.id === sid); }
function activeSession() { return getSession(activeSid); }

// History compares the text the review box opened on with the text that
// was submitted. A fetch or search preview is execution JSON; the box
// opened on the page or review text, not on that JSON.
function searchReviewText(value) {
    const stdout = typeof value.stdout === 'string' ? value.stdout : '';
    const stderr = typeof value.stderr === 'string' ? value.stderr : '';
    const code = value && Object.prototype.hasOwnProperty.call(value, 'exit_code') ? value.exit_code : null;
    if (stdout.trim()) {
        if (code === 0 || !stderr.trim()) return stdout;
        return stdout + '\nstderr:\n' + stderr;
    }
    const note = code === 0 ? 'Web tool returned no content.' : 'Web tool retrieval failed.';
    if (!stderr.trim()) return note;
    const shown = code == null ? 'None' : ('Some(' + code + ')');
    return note + '\nstderr:\n' + stderr + '\nexit code: ' + shown;
}
function reviewableToolText(name, output) {
    const text = output == null ? '' : String(output);
    if (!text.trim().startsWith('{')) return text;
    let value;
    try { value = JSON.parse(text); } catch (e) { return text; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.stdout !== 'string') return text;
    if (name === 'run_cmd') return text;
    if (name === 'web_fetch') {
        if (String(value.stdout).trim()) return value.stdout;
        return 'Web fetch returned no page text.';
    }
    if (name === 'web_search') return searchReviewText(value);
    return value.stdout;
}
// The model receives a JSON envelope. History marks the page text inside it:
// fetch, PDF, and corpus results use content; search uses results.
function submittedReviewText(name, output) {
    const text = output == null ? '' : String(output);
    if (name === 'run_cmd' || !text.trim().startsWith('{')) return text;
    let value;
    try { value = JSON.parse(text); } catch (e) { return text; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return text;
    if (name === 'web_search') return typeof value.results === 'string' ? value.results : text;
    if ((name === 'web_fetch' || name === 'read_pdf') && typeof value.content === 'string') return value.content;
    if (typeof name === 'string' && name.endsWith('_search') && typeof value.content === 'string') return value.content;
    return text;
}
function sameToolText(a, b) {
    return String(a == null ? '' : a).replace(/\r\n/g, '\n') === String(b == null ? '' : b).replace(/\r\n/g, '\n');
}
// Line diff for a curated tool call or output. A changed line is a
// removed line followed by the added line. Null means the texts are too
// long to mark line by line.
function diffLines(before, after) {
    const a = String(before == null ? '' : before).replace(/\r\n/g, '\n').split('\n');
    const b = String(after == null ? '' : after).replace(/\r\n/g, '\n').split('\n');
    if (a.length > 1200 || b.length > 1200) return null;
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let aEnd = a.length;
    let bEnd = b.length;
    while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
        aEnd--;
        bEnd--;
    }
    const mid = lcsLineDiff(a.slice(start, aEnd), b.slice(start, bEnd));
    if (!mid) return null;
    const ops = [];
    for (let i = 0; i < start; i++) ops.push({ op: 'eq', line: a[i] });
    for (let i = 0; i < mid.length; i++) ops.push(mid[i]);
    for (let i = aEnd; i < a.length; i++) ops.push({ op: 'eq', line: a[i] });
    return ops;
}
function lcsLineDiff(a, b) {
    const n = a.length;
    const m = b.length;
    if (!n && !m) return [];
    if (!n) return b.map(line => ({ op: 'add', line: line }));
    if (!m) return a.map(line => ({ op: 'del', line: line }));
    if (n * m > 800000) return null;
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1] + 1
                : (dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1]);
        }
    }
    const ops = [];
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
        if (a[i - 1] === b[j - 1]) {
            ops.push({ op: 'eq', line: a[i - 1] });
            i--;
            j--;
        } else if (dp[i][j - 1] >= dp[i - 1][j]) {
            // Recorded from the end. Taking the added line first here puts
            // the removed line above it after the list is reversed.
            ops.push({ op: 'add', line: b[j - 1] });
            j--;
        } else {
            ops.push({ op: 'del', line: a[i - 1] });
            i--;
        }
    }
    while (i > 0) { ops.push({ op: 'del', line: a[i - 1] }); i--; }
    while (j > 0) { ops.push({ op: 'add', line: b[j - 1] }); j--; }
    ops.reverse();
    return ops;
}
// DOM handles stay off the round data. Persist and export stringify that
// data, and a node would cycle through its parent.
const toolDom = typeof WeakMap === 'function' ? new WeakMap() : null;
function rememberToolDom(item, fields) {
    if (!toolDom || !item || !fields) return;
    const prev = toolDom.get(item);
    toolDom.set(item, prev ? Object.assign(prev, fields) : fields);
}
function toolDomFields(item) {
    return (toolDom && item && toolDom.get(item)) || {};
}
function clearNode(el) {
    if (!el) return;
    if (typeof el.replaceChildren === 'function') el.replaceChildren();
    else if (el.children) el.children.length = 0;
    el.textContent = '';
}
function renderLineDiff(parent, before, after) {
    if (!parent) return;
    const left = before == null ? '' : String(before);
    const right = after == null ? '' : String(after);
    const state = { open: false };
    if (!left) {
        const lines = right.split('\n');
        for (let i = 0; i < lines.length; i++) appendDiffSpan(parent, 'add', lines[i], state);
        return;
    }
    const ops = diffLines(left, right);
    if (!ops) {
        const note = document.createElement('div');
        note.className = 'metrics';
        note.textContent = 'Change is too large to mark line by line. The block below is the edited text.';
        parent.appendChild(note);
        const plain = document.createElement('div');
        fillCommented(plain, right);
        parent.appendChild(plain);
        return;
    }
    for (let i = 0; i < ops.length; i++) appendDiffSpan(parent, ops[i].op, ops[i].line, state);
}
// Bidi and C0/C1 controls are written out. The diff text is model or
// file text, and it is only ever assigned with textContent.
function diffVisible(value) {
    return String(value == null ? '' : value).replace(
        /[\u0000-\u0008\u000A-\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F]/g,
        ch => '\\u' + ch.codePointAt(0).toString(16).padStart(4, '0')
    );
}
// A server diff: op is equal, insert, or delete. spans mark the changed
// words inside a replaced line. skipped is a run of unchanged lines that
// was left out. Text is never written with innerHTML.
// Prism language class for a file path, limited to the grammars the
// bundle actually carries. '' means plain text — never a wrong grammar.
// Display-only: the characters shown are the characters written.
function languageForPath(path) {
    const name = String(path == null ? '' : path).toLowerCase();
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot + 1) : '';
    const map = {
        rs: 'rust', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash',
        c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
        go: 'go', odin: 'odin', gd: 'gdscript', mojo: 'mojo',
        js: 'javascript', mjs: 'javascript', cjs: 'javascript',
        ts: 'typescript', mts: 'typescript', cts: 'typescript',
        kt: 'kotlin', kts: 'kotlin',
        java: 'java', lua: 'lua', pl: 'perl', pm: 'perl',
        html: 'html', htm: 'html', xhtml: 'html',
        xml: 'xml', svg: 'svg', rss: 'rss', atom: 'atom',
        css: 'css', json: 'json', webmanifest: 'json',
    };
    return map[ext] || '';
}
// Highlight one diff line in place: a code child with the language class,
// the same characters (textContent identical), token spans only. Without
// the grammar or Prism the line stays plain text.
function highlightDiffLine(span, text, language) {
    if (!language) {
        span.textContent = text;
        return;
    }
    const code = document.createElement('code');
    code.className = 'language-' + language;
    code.textContent = text;
    span.appendChild(code);
    try {
        if (typeof window !== 'undefined' && window.Prism && Prism.highlightElement) {
            Prism.highlightElement(code);
        }
    } catch (e) {}
}
// A new-file write preview is not a diff: it is the proposed text
// itself, rendered as one Prism block for the file's language so code
// reads like code. Comment-tag lines take the house comment painting
// per line instead (the same treatment the diff view gives them),
// because the harness's own markers must stay visible. Characters shown
// are the characters written: textContent only, never innerHTML.
function renderFileContent(parent, content, language) {
    if (!parent) return;
    if (typeof clearNode === 'function') clearNode(parent);
    else parent.textContent = '';
    const text = String(content == null ? '' : content);
    if (text.indexOf('<user_comment>') >= 0 || text.indexOf('</user_comment>') >= 0) {
        const state = { open: false };
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const span = document.createElement('span');
            span.className = 'diff-line';
            const parts = commentParts(lines[i], state);
            if (parts.length === 1 && !parts[0].comment) {
                if (language && typeof highlightDiffLine === 'function') highlightDiffLine(span, lines[i], language);
                else span.textContent = lines[i];
            } else paintCommentParts(span, parts);
            parent.appendChild(span);
        }
        return;
    }
    const pre = document.createElement('pre');
    pre.className = 'file-content';
    const code = document.createElement('code');
    if (language) code.className = 'language-' + language;
    code.textContent = typeof safeDisplay === 'function' ? safeDisplay(text) : text;
    pre.appendChild(code);
    parent.appendChild(pre);
    if (typeof highlightRendered === 'function') highlightRendered(pre);
}

function renderStructuredDiff(parent, diff, language) {
    if (!parent || !diff) return;
    const state = { open: false };
    if (typeof diff.note === 'string' && diff.note) {
        const note = document.createElement('div');
        note.className = 'metrics';
        note.textContent = diffVisible(diff.note);
        parent.appendChild(note);
    }
    const lines = Array.isArray(diff.lines) ? diff.lines : [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] || {};
        if (line.skipped) {
            const skip = document.createElement('span');
            skip.className = 'diff-skip';
            const n = Number(line.skipped) || 0;
            skip.textContent = '… ' + n + ' unchanged ' + (n === 1 ? 'line' : 'lines') + ' …';
            parent.appendChild(skip);
            continue;
        }
        const op = line.op === 'delete' ? 'del' : line.op === 'insert' ? 'add' : 'eq';
        const span = document.createElement('span');
        span.className = 'diff-line' + (op === 'del' ? ' diff-del' : op === 'add' ? ' diff-add' : '');
        const text = diffVisible(line.text == null ? '' : line.text);
        const spans = Array.isArray(line.spans) ? line.spans : null;
        const commentInLine = text.indexOf('<user_comment>') >= 0 || text.indexOf('</user_comment>') >= 0 || state.open;
        if (spans && spans.length && !commentInLine) {
            for (let s = 0; s < spans.length; s++) {
                const part = spans[s] || {};
                const bit = document.createElement('span');
                if (part.op === 'delete' || part.op === 'insert') bit.className = 'diff-inline';
                bit.textContent = diffVisible(part.text == null ? '' : part.text);
                span.appendChild(bit);
            }
        } else {
            const parts = commentParts(text, state);
            if (parts.length === 1 && !parts[0].comment) {
                // Lines without inline change spans carry the language
                // highlighting; word-marked lines keep their marking.
                if (language) highlightDiffLine(span, text, language);
                else span.textContent = text;
            }
            else paintCommentParts(span, parts);
        }
        parent.appendChild(span);
    }
}
function appendDiffSpan(parent, op, line, state) {
    const span = document.createElement('span');
    span.className = 'diff-line' + (op === 'del' ? ' diff-del' : op === 'add' ? ' diff-add' : '');
    const parts = commentParts(line, state || { open: false });
    if (parts.length === 1 && !parts[0].comment) span.textContent = line == null ? '' : String(line);
    else paintCommentParts(span, parts);
    parent.appendChild(span);
}
function replaceWithLineDiff(el, before, after) {
    clearNode(el);
    renderLineDiff(el, before, after);
}
function timeoutWasEdited(args, chosen) {
    if (!chosen) return false;
    const phrase = typeof runCmdTimeoutPhrase === 'function' ? runCmdTimeoutPhrase(args) : '';
    if (!phrase) return false;
    return phrase !== String(chosen).trim();
}
// The green timeout line history shows after a stage-one limit change.
function timeoutEditLine(chosen) {
    const phrase = String(chosen == null ? '' : chosen).trim();
    if (phrase === '30s') return 'Timeout: 30s';
    if (phrase === '20m') return 'Timeout: 20 minutes';
    if (phrase === 'none' || phrase === '') return 'Timeout: none';
    return 'Timeout: ' + phrase;
}
// One new string per change, in the order the round recorded them.
// A command change and a limit change on the same approval are two strings.
function rememberEditText(data, text) {
    if (!data) return;
    if (!data.editTexts) data.editTexts = [];
    data.editTexts.push(text == null ? '' : String(text));
}
// A real diff summary from the server (`+N/-M` plus the first changed
// lines). Shown as written. The older text clip is only the fallback
// when a record has no summary.
function rememberEditClip(data, text) {
    if (!data) return;
    if (!data.editClips) data.editClips = [];
    data.editClips.push(text == null ? '' : String(text));
}
function providedEditClips(ev) {
    if (!ev || !Array.isArray(ev.edit_diffs)) return null;
    const lines = [];
    for (let i = 0; i < ev.edit_diffs.length; i++) {
        const item = ev.edit_diffs[i];
        if (item && typeof item.summary === 'string' && item.summary) lines.push(item.summary);
    }
    return lines.length ? lines : null;
}
// Hover preview of one new edit string. The count is that string's lines.
// The clip is the first line that contains a non-whitespace character,
// and only its first 30 characters. Leading blank lines stay in the count
// and are skipped in the clip. A cut string gains "..." so the row is
// visibly incomplete.
function editListing(text) {
    const raw = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    if (raw === '') return '(0 lines)';
    const parts = raw.split('\n');
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    const count = parts.length || 1;
    const head = '(' + count + ' ' + (count === 1 ? 'line' : 'lines') + ')';
    let previewAt = 0;
    for (let i = 0; i < parts.length; i++) {
        if (/\S/.test(parts[i] || '')) { previewAt = i; break; }
    }
    const first = parts[previewAt] == null ? '' : parts[previewAt];
    const chars = Array.from(first);
    const cut = chars.length > 30;
    const shown = cut ? chars.slice(0, 30).join('') : first;
    const incomplete = cut || parts.length > 1;
    if (!shown && !incomplete) return head;
    return head + ' ' + shown + (incomplete ? '...' : '');
}
function roundEditListings(data) {
    if (!data) return [];
    if (Array.isArray(data.editClips) && data.editClips.length) return data.editClips.slice();
    if (!Array.isArray(data.editTexts)) return [];
    const lines = [];
    for (let i = 0; i < data.editTexts.length; i++) lines.push(editListing(data.editTexts[i]));
    return lines;
}
function noteHistoryApproval(data, ev) {
    if (!data || !ev) return null;
    if (ev.decision === 'redirect') data.redirectArmed = (data.redirectArmed || 0) + 1;
    if (ev.decision !== 'approve') return null;
    const hasLimit = !!ev.command_timeout;
    const hasCommand = typeof ev.command === 'string' && ev.command.trim() !== '';
    if (!hasLimit && !hasCommand) return null;
    const calls = data.toolCalls || [];
    for (let i = calls.length - 1; i >= 0; i--) {
        const call = calls[i];
        if (!call || call.limitNoted || call.name !== ev.tool) continue;
        call.limitNoted = true;
        const timeoutEdited = hasLimit && timeoutWasEdited(call.arguments, ev.command_timeout);
        const original = call.arguments && typeof call.arguments.command === 'string' ? call.arguments.command : '';
        const commandEdited = hasCommand && ev.command !== original;
        if (timeoutEdited) {
            call.limitEdited = true;
            call.chosenTimeout = ev.command_timeout;
        }
        if (commandEdited) {
            call.commandEdited = true;
            call.chosenCommand = ev.command;
        }
        if (!timeoutEdited && !commandEdited) return null;
        const clips = providedEditClips(ev);
        if (clips) {
            for (let n = 0; n < clips.length; n++) rememberEditClip(data, clips[n]);
        } else {
            if (commandEdited) rememberEditText(data, call.chosenCommand);
            if (timeoutEdited) rememberEditText(data, timeoutEditLine(call.chosenTimeout));
        }
        return call;
    }
    return null;
}
function historyResultPlan(data, ev) {
    const name = ev && ev.name;
    const previews = (data && data.toolPreviews) || [];
    let preview = null;
    for (let i = previews.length - 1; i >= 0; i--) {
        const item = previews[i];
        if (!item || item.paired || item.name !== name) continue;
        preview = item;
        break;
    }
    if (preview) preview.paired = true;
    const submittedRaw = ev && ev.output != null ? String(ev.output) : '';
    const submitted = submittedReviewText(name, submittedRaw);
    const source = preview ? reviewableToolText(preview.name, preview.output) : '';
    const outputEdited = !!(preview && !sameToolText(source, submitted));
    if (preview && outputEdited) preview.outputEdited = true;
    let bare = false;
    if (data && data.redirectArmed) {
        data.redirectArmed -= 1;
        if (!outputEdited) {
            data.bareRedirects = (data.bareRedirects || 0) + 1;
            bare = true;
        }
    }
    const edited = outputEdited || bare;
    if (edited) {
        const clips = providedEditClips(ev);
        if (clips) {
            for (let n = 0; n < clips.length; n++) rememberEditClip(data, clips[n]);
        } else {
            rememberEditText(data, submitted);
        }
    }
    return {
        preview: preview,
        source: edited && !preview ? '' : source,
        submitted: submitted,
        edited: edited,
        suppress: !!(preview && !edited)
    };
}
function roundEditCount(data) {
    let n = 0;
    if (!data) return 0;
    for (const call of data.toolCalls || []) if (call && (call.limitEdited || call.commandEdited)) n++;
    for (const preview of data.toolPreviews || []) if (preview && preview.outputEdited) n++;
    n += data.bareRedirects || 0;
    return n;
}
function roundToolSummaryGroups(data) {
    if (!data) return [];
    const counts = [];
    const index = {};
    for (const call of data.toolCalls || []) {
        const name = call && call.name ? String(call.name) : 'tool';
        if (index[name] == null) {
            index[name] = counts.length;
            counts.push({ name: name, n: 0, tasks: [] });
        }
        const item = counts[index[name]];
        item.n += 1;
        const phrases = toolHoverPhrases(name, call && call.arguments);
        for (let p = 0; p < phrases.length; p++) item.tasks.push(phrases[p]);
    }
    const edits = roundEditCount(data);
    if (!counts.length && !edits) return [];
    const parts = [];
    for (let i = 0; i < counts.length; i++) {
        const item = counts[i];
        parts.push({ label: item.name + ': ' + item.n, tasks: item.tasks });
    }
    if (edits) {
        const editLines = roundEditListings(data);
        parts.push({ label: 'edits: ' + edits, tasks: editLines.length ? editLines : ['No edit recorded.'] });
    } else {
        parts.push({ label: 'edits: ' + edits });
    }
    return parts;
}
function toolCallDiffText(call) {
    const original = formatToolCallText(call.name, call.arguments);
    const args = {};
    const src = call.arguments || {};
    for (const key in src) if (Object.prototype.hasOwnProperty.call(src, key)) args[key] = src[key];
    if (call.chosenTimeout) args.timeout = call.chosenTimeout;
    if (typeof call.chosenCommand === 'string') args.command = call.chosenCommand;
    return { before: original, after: formatToolCallText(call.name, args) };
}
// ---------- collapse helpers (unchanged logic, session-scoped) ----------
function charsPerLine(el) {
    try {
        const output = el || document.getElementById('output');
        const style = getComputedStyle(output);
        const padX = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0');
        const contentW = Math.max(120, output.clientWidth - padX);
        const probe = document.createElement('span');
        probe.style.visibility = 'hidden';
        probe.style.position = 'absolute';
        probe.style.whiteSpace = 'pre';
        probe.style.font = style.font;
        probe.textContent = '0'.repeat(100);
        // NOTE: appended to body, never to `el` itself — a textarea
        // cannot render children, so probing inside one measures 0
        // and silently falls back to 100 (which once undercounted
        // prompt width and clipped the gutter's last rows).
        // offsetWidth (not getBoundingClientRect) keeps units in the
        // same family as clientWidth under page zoom.
        document.body.appendChild(probe);
        const w = probe.offsetWidth / 100;
        probe.remove();
        if (!(w > 0)) return 100;
        return Math.max(20, Math.floor(contentW / w));
    } catch (e) { return 100; }
}
function visualLineCount(text, cpl) {
    let total = 0;
    const parts = text.split('\n');
    for (const line of parts) total += Math.max(1, Math.ceil(line.length / cpl));
    return total;
}
function previewForBudget(text, cpl, budget) {
    const parts = text.split('\n');
    const out = [];
    let used = 0;
    for (const line of parts) {
        const cost = Math.max(1, Math.ceil(line.length / cpl));
        if (used + cost > budget && out.length > 0) break;
        out.push(line);
        used += cost;
        if (used >= budget) break;
    }
    return { preview: out.join('\n'), used };
}
// OS clipboard. Copy uses the same command path as Ctrl+C, then the async
// clipboard API. There is no in-page clipboard: a failed write is a failed
// copy. Ctrl+V and the menu Paste read the OS clipboard.
// arrive as a paste event whose clipboardData is that same OS text, and
// the field inserts it itself so the gesture cannot be dropped.
function copyWithCommand(text) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
    if (!document.body || typeof document.body.appendChild !== 'function') return false;
    if (typeof document.execCommand !== 'function') return false;
    const previous = document.activeElement;
    const ta = document.createElement('textarea');
    ta.value = text;
    if (typeof ta.setAttribute === 'function') ta.setAttribute('readonly', '');
    if (ta.style) {
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.width = '1px';
        ta.style.height = '1px';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
    }
    document.body.appendChild(ta);
    let ok = false;
    try {
        if (typeof ta.focus === 'function') ta.focus();
        if (typeof ta.select === 'function') ta.select();
        if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(0, ta.value.length);
        ok = document.execCommand('copy') === true;
    } catch (e) {
        ok = false;
    }
    if (typeof ta.remove === 'function') ta.remove();
    else if (ta.parentNode && typeof ta.parentNode.removeChild === 'function') ta.parentNode.removeChild(ta);
    if (previous && previous !== document.activeElement && typeof previous.focus === 'function') {
        try { previous.focus(); } catch (e) {}
    }
    return ok;
}
function writeOsClipboard(text) {
    const value = text == null ? '' : String(text);
    const synced = copyWithCommand(value);
    let clip = null;
    try { clip = (typeof navigator !== 'undefined') ? navigator.clipboard : null; } catch (e) { clip = null; }
    if (clip && typeof clip.writeText === 'function') {
        let pending = null;
        try { pending = clip.writeText(value); } catch (e) { pending = null; }
        if (pending && typeof pending.then === 'function') {
            return pending.then(() => true, () => synced);
        }
    }
    return Promise.resolve(synced);
}
function readOsClipboard() {
    let clip = null;
    try { clip = (typeof navigator !== 'undefined') ? navigator.clipboard : null; } catch (e) { clip = null; }
    if (!clip || typeof clip.readText !== 'function') return Promise.resolve(null);
    let pending = null;
    try { pending = clip.readText(); } catch (e) { return Promise.resolve(null); }
    if (!pending || typeof pending.then !== 'function') return Promise.resolve(null);
    return pending.then(
        text => text == null ? '' : String(text),
        () => null
    );
}
function clipboardField(el) {
    if (!el || typeof el.tagName !== 'string') return false;
    if (el.disabled || el.readOnly) return false;
    const tag = el.tagName.toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    const type = String(el.type || 'text').toLowerCase();
    return type === 'text' || type === 'search' || type === 'url' || type === '';
}
function pasteEventText(event) {
    const data = event && (event.clipboardData || (typeof window !== 'undefined' ? window.clipboardData : null));
    if (!data || typeof data.getData !== 'function') return '';
    try {
        return data.getData('text/plain') || data.getData('text') || '';
    } catch (e) {
        return '';
    }
}
function insertClipboardText(el, text) {
    const value = text == null ? '' : String(text);
    if (typeof el.setRangeText === 'function') {
        const start = el.selectionStart == null ? (el.value || '').length : el.selectionStart;
        const end = el.selectionEnd == null ? start : el.selectionEnd;
        el.setRangeText(value, start, end, 'end');
    } else {
        const current = el.value || '';
        const start = el.selectionStart == null ? current.length : el.selectionStart;
        const end = el.selectionEnd == null ? start : el.selectionEnd;
        el.value = current.slice(0, start) + value + current.slice(end);
        const caret = start + value.length;
        try {
            el.selectionStart = caret;
            el.selectionEnd = caret;
        } catch (e) {}
    }
    if (typeof el.dispatchEvent === 'function') {
        try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    }
}
function onOsPaste(event) {
    const el = event && event.target;
    if (!clipboardField(el)) return;
    const text = pasteEventText(event);
    if (!text) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    insertClipboardText(el, text);
}
let osClipboardInstalled = false;
function installOsClipboard() {
    if (osClipboardInstalled) return;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    osClipboardInstalled = true;
    document.addEventListener('paste', onOsPaste, true);
}
function pasteIntoField(el) {
    if (!clipboardField(el)) return Promise.resolve(false);
    if (typeof el.focus === 'function') el.focus();
    return readOsClipboard().then(text => {
        if (text == null) return false;
        if (text === '') return 'empty';
        insertClipboardText(el, text);
        return true;
    });
}
function copyText(text, btn) {
    const orig = btn ? btn.textContent : 'copy';
    const done = () => {
        if (!btn) return;
        btn.textContent = 'copied!';
        setTimeout(() => { btn.textContent = orig; }, 1200);
    };
    const failed = () => {
        if (!btn) return;
        btn.textContent = 'copy failed';
        setTimeout(() => { btn.textContent = orig; }, 1200);
    };
    return Promise.resolve(writeOsClipboard(text)).then(ok => { if (ok) done(); else failed(); });
}
// Highlighted page text. A button press would drop the highlight, so the
// selection buttons cancel that press on mousedown. The text is read then,
// before the click, and that click writes it to the OS clipboard.
let pageSelectionHeld = '';
function pageSelectionText() {
    try {
        if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return '';
        const sel = window.getSelection();
        return sel && typeof sel.toString === 'function' ? String(sel.toString()) : '';
    } catch (e) {
        return '';
    }
}
function holdPageSelection(event) {
    pageSelectionHeld = pageSelectionText();
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
}
function copySelection(btn) {
    const text = pageSelectionHeld || pageSelectionText();
    pageSelectionHeld = '';
    if (!String(text).trim()) { setStatus('Nothing selected.'); return; }
    copyText(text, btn);
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') installOsClipboard();
