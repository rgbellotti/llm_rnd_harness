// Local Mojo grammar; load after the vendored Python grammar.
// Syntax reference: https://mojolang.org/docs/manual/basics/
// Include older fn/let and ownership spellings for model-generated examples.
Prism.languages.mojo = Prism.languages.extend('python', {
    function: {
        pattern: /((?:^|\s)(?:def|fn)[\t ]+)[a-zA-Z_]\w*(?=\s*[\[(])/,
        lookbehind: true
    },
    'class-name': {
        pattern: /(\b(?:struct|trait|class)\s+)[a-zA-Z_]\w*/,
        lookbehind: true
    },
    keyword: /\b(?:alias|and|as|assert|async|await|borrowed|break|case|class|comptime|continue|def|del|elif|else|except|finally|fn|for|from|if|import|in|inout|is|lambda|let|match|mut|not|or|out|owned|pass|raise|raises|read|ref|return|struct|trait|try|var|while|with|yield)\b/,
    operator: /->|[-+%=]=?|!=|:=|\*\*?=?|\/\/?=?|<[<=>]?|>[=>]?|[&|^~]/
});
// The inherited interpolation grammar points back to Python. Use Mojo
// inside f-string expressions without changing Python's original grammar.
Prism.languages.mojo['string-interpolation'].inside.interpolation.inside.rest = Prism.languages.mojo;
Prism.languages['🔥'] = Prism.languages.mojo;
