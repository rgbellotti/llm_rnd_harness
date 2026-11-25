// Godot 4 additions to Prism 1.30.0's official GDScript grammar.
// Load after prism-gdscript.min.js. Keep the upstream grammar intact.
Prism.languages.gdscript.keyword = new RegExp(
    '\\b(?:await|super)\\b|' + Prism.languages.gdscript.keyword.source
);
Prism.languages.insertBefore('gdscript', 'class-name', {
    annotation: { pattern: /@\w+\b/, alias: 'keyword' }
});
Prism.languages.gd = Prism.languages.gdscript;
