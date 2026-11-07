"use strict";

const ui = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map(element => [element.id, element]),
);
const state = {
  projects: [],
  projectLabels: {},
  nameDraft: null,
  trees: new Map(),
  collapsed: new Set(),
  project: null,
  tree: null,
  folder: null,
  note: null,
  editing: false,
  view: "preview",
  baseline: "",
  markdown: "",
  saveError: "",
  busy: false,
  query: "",
  results: [],
  page: 1,
  hasMore: false,
};

function projectUrl(project = state.project) {
  return "/v2/projects/" + encodeURIComponent(project.external_id);
}

async function request(path, method = "GET", body, headers = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = response.headers.get("content-type")?.includes("application/json");
  const data = await (json ? response.json() : response.text());
  if (!response.ok) {
    const detail = data?.detail;
    const error = new Error(typeof detail === "string" ? detail : `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function dirty() {
  return state.editing && state.markdown !== state.baseline;
}

let saveTimer;
let saveInFlight;

function canDiscard() {
  return !dirty() || window.confirm("Discard unsaved changes to this note?");
}

function showNotice(message = "", isError = false) {
  const notice = ui["projects-dialog"].open ? ui["project-notice"] : ui.notice;
  notice.hidden = !message;
  notice.textContent = message;
  notice.classList.toggle("error", isError);
}

function updateControls() {
  for (const control of [
    ui.reload, ui.more,
    ...ui.formatting.querySelectorAll("button"),
    ui.refresh, ui["new-project"], ui["manage-projects"], ui["close-projects"], ui["project-name"], ui["project-folder"],
    ui["add-project"].querySelector("button"),
    ...ui["project-list"].querySelectorAll("button"),
    ...ui.folders.querySelectorAll("button, input"),
    ...ui["note-list"].querySelectorAll("button"),
  ]) {
    control.disabled = state.busy;
  }
  for (const control of [
    ui.search, ui["new-note"], ui["search-form"].querySelector("button"),
  ]) {
    control.disabled = state.busy || !state.project;
  }
  if (visualEditor && visualEditor.isEditable === state.busy) {
    visualEditor.setEditable(!state.busy, false);
  }
  const needsSave = dirty();
  ui.save.disabled = state.busy || Boolean(saveInFlight) || !needsSave;
  ui.save.hidden = !(needsSave && state.saveError);
  ui["save-status"].hidden = !state.note?.db_checksum;
  const status = saveInFlight ? "Saving…" :
    needsSave ? (state.saveError ? "Save failed" : "Unsaved changes") : "Saved";
  if (ui["save-status"].textContent !== status) ui["save-status"].textContent = status;
  ui["save-status"].classList.toggle("error", Boolean(needsSave && state.saveError));
  updateTableControls();
}

async function run(action, { saveBefore = false } = {}) {
  if (state.busy) return;
  clearTimeout(saveTimer);
  clearTimeout(openTimer);
  state.busy = true;
  closeMenu();
  updateControls();
  showNotice();
  try {
    await saveInFlight?.catch(() => {});
    if (saveBefore) await flushAutosave();
    await action();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    state.busy = false;
    updateControls();
    queueAutosave();
  }
}

let menuAnchor;

function closeMenu(restoreFocus = false) {
  const menu = ui["tree-menu"];
  if (menu.hidden) return;
  menu.hidden = true;
  menuAnchor?.setAttribute("aria-expanded", "false");
  if (restoreFocus) menuAnchor?.focus();
  menuAnchor = null;
}

function showMenu(anchor, actions, event) {
  if (state.busy) return;
  clearTimeout(openTimer);
  event.preventDefault();
  event.stopPropagation();
  closeMenu();
  const menu = ui["tree-menu"];
  menu.replaceChildren(...actions.map(([label, action, danger]) => {
    const button = document.createElement("button");
    button.textContent = label;
    button.type = "button";
    button.setAttribute("role", "menuitem");
    if (danger) button.className = "danger";
    button.addEventListener("click", () => {
      closeMenu(true);
      action();
    });
    return button;
  }));
  menuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  menu.hidden = false;
  const bounds = anchor.getBoundingClientRect();
  const atPointer = event.type === "contextmenu" && (event.clientX || event.clientY);
  menu.style.left = Math.max(4, Math.min(
    atPointer ? event.clientX : bounds.left, innerWidth - menu.offsetWidth - 4,
  )) + "px";
  menu.style.top = Math.max(4, Math.min(
    atPointer ? event.clientY : bounds.bottom, innerHeight - menu.offsetHeight - 4,
  )) + "px";
  menu.firstElementChild.focus();
}

function contextActions(target, anchor, actions) {
  anchor.setAttribute("aria-haspopup", "menu");
  anchor.setAttribute("aria-expanded", "false");
  target.addEventListener("contextmenu", event => showMenu(anchor, actions, event));
  target.addEventListener("keydown", event => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      showMenu(anchor, actions, event);
    }
  });
}

let openTimer;

function nameActions(button, open, rename) {
  button.addEventListener("click", event => {
    clearTimeout(openTimer);
    if (event.detail === 0) open();
    else if (event.detail === 1) {
      // Keep the row mounted while the browser checks for a second click.
      openTimer = setTimeout(open, 400);
    } else if (event.detail === 2) {
      rename();
    }
  });
  button.addEventListener("keydown", event => {
    if (event.key === "F2") {
      event.preventDefault();
      clearTimeout(openTimer);
      rename();
    }
  });
}

function treeItem(project, node) {
  const root = !node;
  const folder = root || node.type === "directory";
  const name = root ? projectLabel(project) : node.title || node.name;
  const path = root ? "/" : node.directory_path;
  const tree = root ? state.trees.get(project.external_id) : node;
  const item = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-row " + (root ? "tree-project" : folder ? "tree-folder" : "tree-note");
  const label = document.createElement("button");
  label.className = "tree-label";
  label.title = name;
  const icon = document.createElement("i");
  icon.className = "tree-icon";
  icon.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = name;
  label.append(icon, text);
  const current = project.external_id === state.project?.external_id;
  if (root && current) row.classList.add("tree-active-project");
  const selected = folder
    ? state.folder?.directory_path === path && !state.note && !state.query
    : state.note?.external_id === node.external_id;
  if (current && selected) label.setAttribute("aria-current", "true");

  const children = folder ? tree?.children.filter(child => child.type === "directory" || isNote(child)) : [];
  const draft = state.nameDraft;
  const newChild = folder && draft?.kind === "note" && !draft.note
    && draft.project.external_id === project.external_id && draft.path === path;
  if (children?.length || newChild) {
    const list = document.createElement("ul");
    for (const child of children ?? []) list.append(treeItem(project, child));
    if (newChild) {
      const placeholder = document.createElement("li");
      placeholder.className = "tree-note";
      placeholder.append(inlineNameField());
      list.append(placeholder);
    }
    const toggle = document.createElement("button");
    toggle.className = "tree-toggle";
    const key = project.external_id + path;
    function updateBranch() {
      const closed = state.collapsed.has(key);
      list.hidden = closed;
      toggle.textContent = closed ? "▸" : "▾";
      toggle.setAttribute("aria-expanded", String(!closed));
      toggle.setAttribute("aria-label", (closed ? "Expand " : "Collapse ") + name);
    }
    toggle.addEventListener("click", () => {
      if (!state.collapsed.delete(key)) state.collapsed.add(key);
      updateBranch();
    });
    updateBranch();
    row.append(toggle);
    item.append(row, list);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "tree-spacer";
    row.append(spacer);
    item.append(row);
    if (root && !tree) {
      const unavailable = document.createElement("p");
      unavailable.className = "tree-unavailable";
      unavailable.textContent = "Notes unavailable";
      item.append(unavailable);
    }
  }

  const open = folder
    ? () => openFolder(project, path)
    : () => openTreeNote(project, node);
  const rename = root
    ? () => startProjectName(project)
    : folder ? () => startFolderRename(project, node) : () => startNoteRename(project, node);
  nameActions(label, open, rename);
  const actions = folder
    ? [["New note", () => newNoteIn(project, path)]]
    : [
      ["Edit note", open],
      ["Rename note…", rename],
      ["Delete note…", () => deleteNote(project, node), true],
    ];
  if (root) {
    actions.push(["New project…", () => startProjectName()]);
    actions.push(["Rename project…", rename]);
    if (!project.is_default) {
      actions.push(["Set as default", () => setDefaultProject(project)]);
    }
    actions.push(["Delete project…", () => removeProject(project), true]);
  } else if (folder) {
    actions.push(["Rename folder…", rename]);
  }
  const more = document.createElement("button");
  more.className = "tree-action";
  more.textContent = "⋯";
  more.setAttribute("aria-label", "Actions for " + name);
  more.addEventListener("click", event => showMenu(more, actions, event));
  contextActions(row, more, actions);
  row.append(label, more);
  if (
    (root && draft?.kind === "project" && draft.project?.external_id === project.external_id)
    || (!folder && draft?.kind === "note" && draft.note?.external_id === node.external_id)
    || (!root && folder && draft?.kind === "folder"
      && draft.project.external_id === project.external_id && draft.path === path)
  ) {
    const replacement = document.createElement("div");
    replacement.className = row.className;
    replacement.append(inlineNameField());
    row.replaceWith(replacement);
  }
  return item;
}

function projectLabel(project) {
  return state.projectLabels[project.external_id] || project.name;
}

function cancelInlineName(draft) {
  if (state.nameDraft !== draft) return;
  state.nameDraft = null;
  renderTree();
  updateControls();
}

document.addEventListener("click", event => {
  const draft = state.nameDraft;
  const renaming = draft?.kind === "note" ? draft.note : draft?.project;
  if (!renaming || state.busy || event.target.closest(".inline-name-field")) return;
  // Let the clicked control finish before replacing any sidebar rows.
  setTimeout(() => cancelInlineName(draft), 0);
}, { capture: true });

function inlineNameField() {
  const draft = state.nameDraft;
  const noun = draft.kind;
  const form = document.createElement("form");
  form.className = "inline-name-field";
  const icon = document.createElement("span");
  icon.className = "tree-icon";
  icon.setAttribute("aria-hidden", "true");
  const input = document.createElement("input");
  input.placeholder = { project: "Project name", folder: "Folder name", note: "Note title" }[noun];
  input.setAttribute("aria-label", input.placeholder);
  input.maxLength = 100;
  input.required = true;
  input.value = draft.name;
  input.addEventListener("input", () => { draft.name = input.value; });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "×";
  cancel.setAttribute("aria-label", `Cancel ${noun} name`);
  cancel.addEventListener("click", () => cancelInlineName(draft));
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelInlineName(draft);
    }
  });
  const confirm = document.createElement("button");
  confirm.type = "submit";
  confirm.textContent = "✓";
  confirm.setAttribute("aria-label", `Confirm ${noun} name`);
  form.append(icon, input, confirm, cancel);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) return;
    if (draft.kind === "project" && state.projects.some(
      project => project.external_id !== draft.project?.external_id
        && projectLabel(project).toLowerCase() === name.toLowerCase(),
    )) {
      showNotice("A project with that name already exists.", true);
      input.focus();
      return;
    }
    void run(async () => {
      if (draft.kind === "note") {
        if (draft.note) await renameNote(draft.project, draft.note, name);
        else await createNote(draft.project, draft.path, name);
      } else if (draft.kind === "folder") {
        await renameFolder(draft.project, draft.path, name);
      } else if (draft.project) {
        await request("/project-labels/" + encodeURIComponent(draft.project.external_id), "PUT", { name });
        state.projectLabels[draft.project.external_id] = name;
        state.nameDraft = null;
        renderProjects();
        renderLists();
      } else {
        await addProject(name, suggestedFolder(name));
      }
    }, {
      saveBefore: draft.kind === "note"
        ? !draft.note || state.note?.external_id === draft.note.external_id
        : draft.kind === "folder" || !draft.project,
    }).then(() => {
      const remaining = ui.folders.querySelector(".inline-name-field input");
      if (remaining) remaining.focus();
      else if (draft.kind === "note" && !draft.note) focusEditor();
    });
  });
  return form;
}

function startInlineName(draft) {
  clearTimeout(openTimer);
  state.nameDraft = draft;
  renderTree();
  updateControls();
  const input = ui.folders.querySelector(".inline-name-field input");
  input?.focus();
  input?.select();
}

function startProjectName(project = null) {
  startInlineName({ kind: "project", project, name: project ? projectLabel(project) : "" });
}

function renderTree() {
  const current = ui.folders.querySelector(".inline-name-field input:focus");
  const list = document.createElement("ul");
  for (const project of state.projects) list.append(treeItem(project, null));
  if (state.nameDraft?.kind === "project" && !state.nameDraft.project) {
    const item = document.createElement("li");
    item.append(inlineNameField());
    list.append(item);
  }
  ui.folders.replaceChildren(list);
  if (current) {
    const replacement = list.querySelector(".inline-name-field input");
    replacement?.focus();
    replacement?.setSelectionRange(current.selectionStart, current.selectionEnd);
  }
}

function allNotes(folder) {
  return folder.children.flatMap(node =>
    node.type === "directory" ? allNotes(node) : [node],
  );
}

function isNote(node) {
  return node.external_id && /\.(?:md|markdown)$/i.test(node.file_path || "");
}

function renderLists() {
  renderTree();
  if (!state.folder) {
    ui["note-list"].replaceChildren();
    ui["list-heading"].textContent = "Notes";
    ui["list-detail"].textContent = "";
    ui.more.hidden = true;
    updateControls();
    return;
  }
  const notes = (state.query ? state.results : (
    state.folder === state.tree ? allNotes(state.tree) : state.folder.children
  )).filter(isNote);
  if (!state.query) notes.sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
  ui["list-heading"].textContent = state.query ? "Search results" : (
    state.folder === state.tree ? projectLabel(state.project) : state.folder.name
  );
  ui["list-detail"].textContent = state.query
    ? `“${state.query}” in ${projectLabel(state.project)}`
    : `${notes.length} ${notes.length === 1 ? "note" : "notes"}`;
  ui["note-list"].replaceChildren();
  if (!notes.length) {
    const empty = document.createElement("li");
    empty.className = "no-results";
    empty.textContent = state.query ? "No matching notes." : "No Markdown notes here yet.";
    ui["note-list"].append(empty);
  }
  for (const note of notes) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "note-row";
    if (note.external_id === state.note?.external_id) button.setAttribute("aria-current", "true");
    const title = document.createElement("strong");
    title.textContent = note.title || note.name;
    const path = document.createElement("span");
    path.className = "note-meta";
    path.textContent = note.file_path;
    button.append(title, path);
    const project = state.project;
    nameActions(
      button, () => openTreeNote(project, note, true), () => startNoteRename(project, note),
    );
    contextActions(button, button, [
      ["Edit note", () => openTreeNote(project, note, true)],
      ["Rename note…", () => startNoteRename(project, note)],
      ["Delete note…", () => deleteNote(project, note), true],
    ]);
    item.append(button);
    ui["note-list"].append(item);
  }
  ui.more.hidden = !state.query || !state.hasMore;
  updateControls();
}

let visualEditor;

function clearFormatted() {
  visualEditor?.destroy();
  visualEditor = null;
}

function updateTableControls() {
  const inTable = Boolean(visualEditor?.isActive("table"));
  ui["table-actions"].hidden = !inTable;
  ui.formatting.querySelector("[data-format=table]").disabled = state.busy || inTable;
  ui.formatting.querySelector("[data-format=delete-row]").disabled =
    state.busy || Boolean(visualEditor?.isActive("tableHeader"));
}

async function loadFormatted() {
  clearFormatted();
  state.view = "preview";
  state.editing = false;

  const original = state.markdown;
  const frontmatter = /^(?:[ \t]*\n)*(?:\uFEFF)?---[ \t]*\n[\s\S]*?^---[ \t]*(?:\n|$)/m.exec(original);
  const prefix = frontmatter?.index === 0 ? frontmatter[0] : "";
  const body = original.slice(prefix.length);
  const leading = /^(?:[ \t]*\n)*/.exec(body)[0];
  const trailing = /\n*$/.exec(body.slice(leading.length))[0];
  const unsupported = /<!--|^\s*::|^ {0,3}\[[^\]\n]+\]:/m.test(body);
  if (!unsupported && window.BasicMemoryEditor) {
    try {
      let canonical;
      const editor = window.BasicMemoryEditor(ui["visual-content"], body, markdown => {
        if (canonical === undefined) return;
        // The editor can add an empty paragraph after a table on first focus.
        markdown = markdown.replace(/\n+$/, "");
        state.markdown = markdown === canonical
          ? original
          : prefix + leading + markdown + trailing;
        updateControls();
        queueAutosave();
      }, updateTableControls);
      visualEditor = editor;
      canonical = editor.getMarkdown().replace(/\n+$/, "");
      const { editable } = await request("/editor-check", "POST", {
        original, frontmatter: prefix, roundtrip: canonical,
      });
      if (editable) {
        state.view = "formatted";
        state.editing = true;
        return;
      }
    } catch {
      // Rendering read-only also handles unavailable editor assets or validation.
    }
  }

  clearFormatted();
  ui.preview.innerHTML = await request("/preview", "POST", { markdown: original });
  showNotice(window.BasicMemoryEditor
    ? "This note is read-only here because it contains unsupported formatting."
    : "The formatted editor is unavailable.");
}

function focusEditor() {
  visualEditor?.commands.focus();
}

async function openNote(id, accepted = null) {
  const note = accepted ?? await request(projectUrl() + "/knowledge/entities/" + encodeURIComponent(id));
  if (typeof note.content !== "string") throw new Error("Markdown content is unavailable.");
  clearFormatted();
  const editable = Boolean(note.db_checksum);
  if (!editable) {
    ui.preview.innerHTML = await request("/preview", "POST", { markdown: note.content });
  }
  state.note = note;
  state.saveError = "";
  state.editing = editable;
  state.view = "preview";
  state.markdown = note.content.replace(/\r\n?/g, "\n");
  state.baseline = state.markdown;
  if (editable) await loadFormatted();
  renderEditor();
  renderLists();
}

function renderEditor() {
  const active = Boolean(state.note);
  ui.empty.hidden = active;
  ui.preview.hidden = !active || state.view !== "preview";
  ui.visual.hidden = !active || state.view !== "formatted";
  ui.reload.hidden = !state.note;
  ui["note-path"].textContent = state.note?.title ?? "Workspace";
  ui["note-path"].title = state.note?.file_path ?? "";
  updateControls();
}

async function search(query, page = 1) {
  if (!query) {
    state.query = "";
    renderLists();
    return;
  }
  const response = await request(projectUrl() + `/search/?page=${page}&page_size=25`, "QUERY", {
    text: query,
    entity_types: ["entity"],
  });
  state.results = page === 1 ? response.results : state.results.concat(response.results);
  state.query = query;
  state.page = page;
  state.hasMore = response.has_more;
  renderLists();
}

function findFolder(tree, path) {
  if (tree.directory_path === path) return tree;
  for (const child of tree.children.filter(node => node.type === "directory")) {
    const folder = findFolder(child, path);
    if (folder) return folder;
  }
  return null;
}

async function refreshTree() {
  const tree = await fetchTree(state.project);
  state.folder = findFolder(tree, state.folder.directory_path) ?? tree;
  state.tree = tree;
  renderLists();
}

async function fetchTree(project) {
  const tree = await request(projectUrl(project) + "/directory/tree");
  state.trees.set(project.external_id, tree);
  return tree;
}

async function selectProject(project, noteId, folderPath = "/", openStart = true) {
  const tree = state.trees.get(project.external_id) ?? await fetchTree(project);
  state.project = project;
  state.tree = tree;
  state.folder = findFolder(tree, folderPath) ?? tree;
  state.note = null;
  state.saveError = "";
  state.editing = false;
  state.view = "preview";
  clearFormatted();
  state.query = "";
  ui.search.value = "";
  renderEditor();
  renderLists();
  if (noteId) {
    await openNote(noteId);
    return;
  }
  const start = allNotes(tree).find(note =>
    isNote(note) && /^(?:start-here|index)\.md$/i.test(note.file_path),
  );
  if (openStart && start) await openNote(start.external_id);
}

function browseFolder(path) {
  state.folder = findFolder(state.tree, path) ?? state.tree;
  state.query = "";
  ui.search.value = "";
  renderLists();
}

function openFolder(project, path) {
  if (project.external_id === state.project?.external_id) {
    browseFolder(path);
  } else {
    void run(() => selectProject(project, null, path, path === "/"), { saveBefore: true });
  }
}

function openTreeNote(project, note, keepList = false) {
  const current = project.external_id === state.project?.external_id;
  if (current && note.external_id === state.note?.external_id) {
    focusEditor();
    return;
  }
  void run(async () => {
    const path = "/" + note.file_path.split("/").slice(0, -1).join("/");
    if (current) {
      await openNote(note.external_id);
      if (!keepList) browseFolder(path);
    } else {
      await selectProject(project, note.external_id, path);
    }
  }, { saveBefore: true }).then(() => {
    if (state.note?.external_id === note.external_id) focusEditor();
  });
}

function expandNoteFolder(project, path) {
  const parts = path.split("/").filter(Boolean);
  state.collapsed.delete(project.external_id + "/");
  for (let index = 1; index <= parts.length; index++) {
    state.collapsed.delete(project.external_id + "/" + parts.slice(0, index).join("/"));
  }
}

function newNoteIn(project, path) {
  expandNoteFolder(project, path);
  startInlineName({ kind: "note", project, path, name: "" });
}

function startNoteRename(project, note) {
  const path = "/" + note.file_path.split("/").slice(0, -1).join("/");
  expandNoteFolder(project, path);
  startInlineName({ kind: "note", project, note, name: note.title || note.name });
}

function startFolderRename(project, folder) {
  expandNoteFolder(project, folder.directory_path);
  startInlineName({ kind: "folder", project, path: folder.directory_path, name: folder.name });
}

async function renameFolder(project, source, name) {
  const parent = source.slice(0, source.lastIndexOf("/"));
  const destination = parent + "/" + name;
  if (destination === source) {
    state.nameDraft = null;
    renderLists();
    return;
  }
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name) || name === "." || name === "..") {
    throw new Error("Enter a folder name without path separators or reserved characters.");
  }
  const tree = await fetchTree(project);
  const siblings = findFolder(tree, parent || "/")?.children ?? [];
  if (siblings.some(entry => entry.name.toLowerCase() === name.toLowerCase())) {
    throw new Error("That name is already used in this folder. Choose a different name.");
  }

  const result = await request(projectUrl(project) + "/knowledge/move-directory", "POST", {
    source_directory: source.slice(1),
    destination_directory: destination.slice(1),
  });
  if (result.successful_moves > 0) state.nameDraft = null;
  const updatedTree = await fetchTree(project);
  expandNoteFolder(project, destination);
  if (project.external_id === state.project?.external_id) {
    const currentFolder = state.folder.directory_path;
    const currentNote = state.note;
    const renamedFolder = currentFolder === source || currentFolder.startsWith(source + "/")
      ? destination + currentFolder.slice(source.length)
      : currentFolder;
    state.tree = updatedTree;
    state.folder = findFolder(updatedTree, renamedFolder)
      ?? findFolder(updatedTree, currentFolder) ?? updatedTree;
    if (currentNote?.file_path.startsWith(source.slice(1) + "/")) {
      await openNote(currentNote.external_id);
    }
    if (state.query) await search(state.query);
  }
  renderLists();
  if (result.failed_moves > 0) {
    showNotice(`Moved ${result.successful_moves} of ${result.total_files} files. ${result.errors[0]?.error ?? "Some files could not be moved."}`, true);
  } else if (result.successful_moves === 0) {
    showNotice("There were no indexed files to move.", true);
  }
}

async function createNote(project, path, title) {
  const response = await request(projectUrl(project) + "/knowledge/write", "POST", {
    note: { title, directory: path.replace(/^\//, ""), content: "" },
  });
  if (response.kind === "already_exists") {
    throw new Error("A note with that name already exists in this folder.");
  }
  if (response.kind !== "created") throw new Error("The note could not be created.");
  state.nameDraft = null;
  await fetchTree(project);
  await selectProject(project, response.entity.external_id, path);
}

async function renameNote(project, note, title) {
  const selected = project.external_id === state.project?.external_id
    && state.note?.external_id === note.external_id;
  const path = projectUrl(project) + "/knowledge/entities/" + encodeURIComponent(note.external_id);
  const revision = selected ? state.note : await request(path);
  if (!revision.db_checksum) throw new Error("The note revision could not be verified.");
  let accepted = revision;
  if (title !== revision.title) {
    try {
      accepted = await request(path, "PATCH", { operation: "rename", content: title }, {
        "x-bm-cloud-note-base-checksum": revision.db_checksum,
      });
    } catch (error) {
      if (error.status === 409) throw new Error("The note changed. Reload it before renaming.");
      throw error;
    }
  }
  state.nameDraft = null;
  if (selected) await openNote(note.external_id, accepted);
  if (project.external_id === state.project?.external_id) {
    await refreshTree();
    if (state.query) await search(state.query);
  } else {
    await fetchTree(project);
    renderLists();
  }
}

function deleteNote(project, note) {
  const current = project.external_id === state.project?.external_id;
  const selected = current && state.note?.external_id === note.external_id;
  void run(async () => {
    if (selected && !canDiscard()) return;
    const path = projectUrl(project) + "/knowledge/entities/" + encodeURIComponent(note.external_id);
    const revision = selected ? state.note : await request(path);
    if (!revision.db_checksum) throw new Error("The note revision could not be verified.");
    if (!window.confirm(`Delete “${revision.title}” from ${projectLabel(project)} and remove its Markdown file?`)) return;
    try {
      const result = await request(path, "DELETE", undefined, {
        "x-bm-cloud-note-base-checksum": revision.db_checksum,
      });
      if (!result.deleted) throw new Error("The note could not be deleted.");
    } catch (error) {
      if (error.status === 409) throw new Error("The note changed. Reload it before deleting.");
      throw error;
    }
    if (selected) {
      state.note = null;
      state.editing = false;
      state.view = "preview";
      clearFormatted();
      renderEditor();
    }
    try {
      if (current) {
        await refreshTree();
        if (state.query) await search(state.query);
      } else {
        await fetchTree(project);
        renderLists();
      }
      showNotice("Note deleted.");
    } catch (error) {
      showNotice(`Note deleted. Could not refresh the note list. ${error.message}`, true);
    }
  });
}

function setDefaultProject(project) {
  void run(async () => {
    await request(projectUrl(project) + "/default", "PUT");
    await loadProjects();
    showNotice(`${projectLabel(project)} is now the default project.`);
  });
}

function removeProject(project) {
  if (project.is_default) {
    const nextStep = state.projects.length > 1
      ? "Set another project as default first."
      : "Add another project and make it the default first.";
    showNotice(`“${projectLabel(project)}” is the default project. ${nextStep}`, true);
    return;
  }
  const current = project.external_id === state.project?.external_id;
  void run(async () => {
    if (current && !canDiscard()) return;
    if (!window.confirm(`Remove ${projectLabel(project)} from Basic Memory? The Markdown files will stay in ${project.path}.`)) return;
    await request(projectUrl(project), "DELETE");
    state.trees.delete(project.external_id);
    await loadProjects();
    if (current) await selectProject(state.projects.find(entry => entry.is_default) ?? state.projects[0]);
    showNotice(`${projectLabel(project)} was removed. Its Markdown files were kept.`);
  });
}

document.addEventListener("pointerdown", event => {
  if (!ui["tree-menu"].contains(event.target)) closeMenu();
});
window.addEventListener("resize", () => closeMenu(true));
ui["tree-menu"].addEventListener("keydown", event => {
  if (event.key === "Escape" || event.key === "Tab") {
    closeMenu(true);
    if (event.key === "Escape") event.preventDefault();
    return;
  }
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = [...ui["tree-menu"].children];
  const index = buttons.indexOf(document.activeElement);
  const next = {
    ArrowUp: (index + buttons.length - 1) % buttons.length,
    ArrowDown: (index + 1) % buttons.length,
    Home: 0,
    End: buttons.length - 1,
  }[event.key];
  buttons[next].focus();
});

async function saveNote() {
  const { note, markdown: content } = state;
  const file = note.file_path.split("/");
  const response = await request(projectUrl() + "/knowledge/write", "POST", {
    note: {
      title: note.title,
      content,
      directory: file.slice(0, -1).join("/"),
      file_name: file.at(-1),
      note_type: note.note_type,
    },
    overwrite: true,
    expected_checksum: note.db_checksum,
  });
  const errors = {
    revision_conflict: "This note changed since you opened it. Your draft is still here. Copy your edits before reloading the note.",
    target_moved: "This note moved since you opened it. Your draft is still here.",
    already_exists: "A note with that name already exists in this folder.",
    locked: response.message || "This note is locked.",
  };
  if (response.kind !== "updated") {
    throw new Error(errors[response.kind] || "The note was not saved.");
  }
  state.note = response.entity;
  // The saved snapshot is the baseline. Never replace the text the user is still typing.
  state.baseline = content;
  renderEditor();
  if (note.title !== state.note.title) {
    try {
      await refreshTree();
      if (state.query) await search(state.query);
    } catch (error) {
      showNotice(`Note saved. Could not refresh the note list. ${error.message}`, true);
    }
  }
}

function startAutosave() {
  if (saveInFlight) return saveInFlight;
  state.saveError = "";
  saveInFlight = saveNote().catch(error => {
    state.saveError = error.message;
    showNotice(error.message, true);
    throw error;
  }).finally(() => {
    saveInFlight = null;
    updateControls();
    queueAutosave();
  });
  updateControls();
  return saveInFlight;
}

function queueAutosave() {
  clearTimeout(saveTimer);
  if (!state.note?.db_checksum || !dirty() || state.busy || saveInFlight || state.saveError) return;
  saveTimer = setTimeout(() => {
    void startAutosave().catch(() => {});
  }, 650);
}

async function flushAutosave() {
  clearTimeout(saveTimer);
  while (state.note && dirty()) {
    if (state.saveError) throw new Error(state.saveError);
    await startAutosave();
  }
}

ui["search-form"].addEventListener("submit", event => {
  event.preventDefault();
  if (state.project) void run(() => search(ui.search.value.trim()));
});
ui.more.addEventListener("click", () => void run(() => search(state.query, state.page + 1)));
ui.refresh.addEventListener("click", () => void run(async () => {
  await loadProjects(true);
  if (state.project && state.projects.some(project => project.external_id === state.project.external_id)) {
    const tree = state.trees.get(state.project.external_id);
    if (tree) {
      state.folder = findFolder(tree, state.folder.directory_path) ?? tree;
      state.tree = tree;
      renderLists();
    }
    if (state.query) await search(state.query);
  }
}));
ui["new-note"].addEventListener("click", () => newNoteIn(state.project, state.folder.directory_path));
ui.formatting.addEventListener("mousedown", event => {
  // Keep the document selection when a formatting button is clicked.
  if (event.target.closest("[data-format]")) event.preventDefault();
});
ui.formatting.addEventListener("click", event => {
  const format = event.target.closest("[data-format]")?.dataset.format;
  if (!format || !visualEditor) return;
  const command = visualEditor.chain().focus();
  if (format === "heading") command.toggleHeading({ level: 2 }).run();
  if (format === "bold") command.toggleBold().run();
  if (format === "italic") command.toggleItalic().run();
  if (format === "bullets") command.toggleBulletList().run();
  if (format === "numbers") command.toggleOrderedList().run();
  if (format === "table") command.insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run();
  if (format === "row") command.addRowAfter().run();
  if (format === "column") command.addColumnAfter().run();
  if (format === "delete-row") command.deleteRow().run();
  if (format === "delete-column") command.deleteColumn().run();
  if (format === "delete-table") command.deleteTable().run();
});
ui.preview.addEventListener("click", event => {
  const link = event.target.closest("[data-wikilink]");
  if (!link) return;
  event.preventDefault();
  if (state.busy) return;
  void run(async () => {
    const target = await request(projectUrl() + "/knowledge/links/resolve", "QUERY", {
      identifier: link.dataset.wikilink,
      source_path: state.note?.file_path,
      strict: true,
    });
    const project = state.projects.find(entry => entry.external_id === target.target_project_external_id);
    if (!project || !isNote(target)) throw new Error("The link does not point to a local Markdown note.");
    if (project.external_id === state.project.external_id) await openNote(target.external_id);
    else await selectProject(project, target.external_id);
  }, { saveBefore: true });
});
ui.reload.addEventListener("click", () => void run(async () => {
  if (canDiscard()) await openNote(state.note.external_id);
}));
ui.save.addEventListener("click", () => {
  showNotice();
  void startAutosave().catch(() => {});
});
window.addEventListener("beforeunload", event => {
  if (dirty() || saveInFlight) event.preventDefault();
});
document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !state.busy) {
    event.preventDefault();
    ui.search.focus();
  }
});

async function loadProjects(refresh = false) {
  const [{ projects }, labels] = await Promise.all([
    request("/v2/projects/"), request("/project-labels"),
  ]);
  state.projects = projects;
  state.projectLabels = labels;
  const current = projects.find(entry => entry.external_id === state.project?.external_id);
  if (current) state.project = current;
  await Promise.allSettled(projects
    .filter(project => refresh || !state.trees.has(project.external_id))
    .map(project => fetchTree(project)));
  renderProjects();
  renderTree();
  updateControls();
}

function projectButton(label, project, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-label", `${label} ${projectLabel(project)}`);
  button.addEventListener("click", action);
  return button;
}

function renderProjects() {
  ui["project-list"].replaceChildren();
  for (const project of state.projects) {
    const row = document.createElement("li");
    row.className = "project-row";
    const details = document.createElement("div");
    details.className = "project-details";
    const name = projectButton(projectLabel(project), project, () => {
      if (project.external_id === state.project?.external_id) {
        ui["projects-dialog"].close();
      } else {
        void run(async () => {
          await selectProject(project);
          ui["projects-dialog"].close();
        }, { saveBefore: true });
      }
    });
    name.className = "project-name";
    name.removeAttribute("aria-label");
    details.append(name);
    if (project.is_default) {
      const badge = document.createElement("span");
      badge.className = "project-default";
      badge.textContent = "Default";
      details.append(badge);
    }
    const path = document.createElement("p");
    path.className = "project-path";
    path.textContent = project.path;
    details.append(path);

    const actions = document.createElement("div");
    actions.className = "actions";
    if (!project.is_default) {
      actions.append(projectButton("Set default", project, () => setDefaultProject(project)));
    }
    actions.append(projectButton("Delete", project, () => removeProject(project)));
    row.append(details, actions);
    ui["project-list"].append(row);
  }
  updateControls();
}

function suggestedFolder(name) {
  const folder = name.replace(/[<>:"/\\|?*]/g, "-").replace(/^[.]+/, "");
  return `~/basic-memory-projects/${folder || "New project"}`;
}

ui["project-name"].addEventListener("input", () => {
  ui["project-folder"].placeholder = suggestedFolder(ui["project-name"].value.trim());
});
function openProjects() {
  ui["projects-dialog"].showModal();
  void run(loadProjects);
}

ui["new-project"].addEventListener("click", () => startProjectName());
ui["manage-projects"].addEventListener("click", openProjects);
contextActions(ui["projects-toolbar"], ui["manage-projects"], [
  ["New project…", () => startProjectName()],
  ["Manage projects", openProjects],
]);
ui["close-projects"].addEventListener("click", () => ui["projects-dialog"].close());
ui["projects-dialog"].addEventListener("cancel", event => {
  if (state.busy) event.preventDefault();
});
ui["add-project"].addEventListener("submit", event => {
  event.preventDefault();
  const name = ui["project-name"].value.trim();
  const path = ui["project-folder"].value.trim() || suggestedFolder(name);
  if (!name || !/^(?:~?\/|[a-z]:[\\/])/i.test(path)) {
    showNotice("Enter a project name and a full local folder path.", true);
    return;
  }
  void run(() => addProject(name, path), { saveBefore: true });
});

async function addProject(name, path) {
  const { new_project: project } = await request("/v2/projects/", "POST", {
    name, path, set_default: state.projects.length === 0,
  });
  state.nameDraft = null;
  ui["add-project"].reset();
  ui["project-folder"].placeholder = suggestedFolder("");
  await loadProjects();
  showNotice(`Indexing notes in ${name}…`);
  try {
    await request(projectUrl(project) + "/index?run_in_background=false", "POST");
  } catch (error) {
    showNotice(`Project added. The notes could not be indexed yet. ${error.message}`, true);
    return;
  }
  await fetchTree(project);
  await selectProject(state.projects.find(entry => entry.external_id === project.external_id));
  if (ui["projects-dialog"].open) ui["projects-dialog"].close();
  showNotice(`Project ${name} is ready.`);
}

void run(async () => {
  await loadProjects();
  const project = state.projects.find(entry => entry.is_default) ?? state.projects[0];
  if (project) await selectProject(project);
  else showNotice("Use the plus button to add your first project.");
});
