import { Editor, Node } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

const wikiLinkPattern = /\[\[([^|\[\]\n]+)(?:\|([^\[\]\n]+))?\]\]/;

const WikiLink = Node.create({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return { raw: { default: "" }, label: { default: "" } };
  },
  renderHTML({ node }) {
    return ["span", { class: "visual-wikilink" }, node.attrs.label];
  },
  renderText({ node }) {
    return node.attrs.raw;
  },
  markdownTokenizer: {
    name: "wikiLink",
    level: "inline",
    start: source => source.search(wikiLinkPattern),
    tokenize(source) {
      const match = wikiLinkPattern.exec(source);
      if (match?.index !== 0) return undefined;
      return { type: "wikiLink", raw: match[0], label: match[2] || match[1] };
    },
  },
  parseMarkdown(token, helpers) {
    return helpers.createNode("wikiLink", { raw: token.raw, label: token.label });
  },
  renderMarkdown(node) {
    return node.attrs.raw;
  },
});

window.BasicMemoryEditor = (element, content, onChange) => new Editor({
  element,
  content,
  contentType: "markdown",
  extensions: [
    StarterKit.configure({ underline: false, link: { openOnClick: false } }),
    Markdown,
    WikiLink,
  ],
  injectCSS: false,
  editorProps: {
    attributes: {
      role: "textbox",
      "aria-label": "Formatted note",
      "aria-multiline": "true",
      class: "visual-document",
    },
  },
  onUpdate: ({ editor }) => onChange(editor.getMarkdown()),
});
