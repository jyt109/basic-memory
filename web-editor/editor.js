import { Editor, Extension, Node } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Plugin } from "@tiptap/pm/state";
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

// Markdown tables have one inline paragraph per cell, with a fixed header row.
function markdownCell(extension) {
  return extension.extend({
    content: "paragraph",
    addAttributes() {
      const attributes = this.parent();
      return {
        ...attributes,
        align: {
          ...attributes.align,
          parseHTML: element => element.dataset.align ?? attributes.align.parseHTML(element),
          renderHTML: ({ align }) => align ? { "data-align": align } : {},
        },
      };
    },
  });
}

function validTables(doc) {
  let valid = true;
  doc.descendants(node => {
    if (!valid || node.type.name !== "table") return valid;
    node.forEach((row, _offset, rowIndex) => row.forEach(cell => {
      const cellType = rowIndex === 0 ? "tableHeader" : "tableCell";
      if (cell.type.name !== cellType || cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1) {
        valid = false;
      }
      cell.descendants(child => {
        if (child.type.name === "hardBreak") valid = false;
      });
    }));
    return false;
  });
  return valid;
}

const MarkdownTableRules = Extension.create({
  name: "markdownTableRules",
  priority: 1100,
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (!this.editor.isActive("table")) return false;
        this.editor.commands.goToNextCell();
        return true;
      },
      "Shift-Enter": () => this.editor.isActive("table"),
    };
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction: transaction => !transaction.docChanged || validTables(transaction.doc),
    })];
  },
});

window.BasicMemoryEditor = (element, content, onChange, onSelection) => new Editor({
  element,
  content,
  contentType: "markdown",
  extensions: [
    StarterKit.configure({ underline: false, link: { openOnClick: false } }),
    Markdown,
    WikiLink,
    Table,
    TableRow,
    markdownCell(TableCell),
    markdownCell(TableHeader),
    MarkdownTableRules,
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
  onSelectionUpdate: onSelection,
});
