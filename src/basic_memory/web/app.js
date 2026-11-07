"use strict";

const ui = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map(element => [element.id, element]),
);
const state = {
  projects: [],
  project: null,
  tree: null,
  folder: null,
  note: null,
  draftFolder: null,
  editing: false,
  showSource: false,
  baseline: "",
  busy: false,
  query: "",
  results: [],
  page: 1,
  hasMore: false,
};

function projectUrl(project = state.project) {
  return "/v2/projects/" + encodeURIComponent(project.external_id);
}

async function request(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = response.headers.get("content-type")?.includes("application/json");
  const data = await (json ? response.json() : response.text());
  if (!response.ok) {
    const detail = data?.detail;
    throw new Error(typeof detail === "string" ? detail : `Request failed (${response.status}).`);
  }
  return data;
}

function dirty() {
  return state.editing && (
    state.note
      ? ui.markdown.value !== state.baseline
      : Boolean(ui.title.value || ui.markdown.value)
  );
}

function canLeave() {
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
    ui.cancel, ui.reload, ui.mode, ui.more, ui.title, ui.markdown,
    ui["manage-projects"], ui["close-projects"], ui["project-name"], ui["project-folder"],
    ui["add-project"].querySelector("button"),
    ...ui["project-list"].querySelectorAll("button"),
    ...ui.folders.querySelectorAll("button"),
    ...ui["note-list"].querySelectorAll("button"),
  ]) {
    control.disabled = state.busy;
  }
  for (const control of [
    ui.project, ui.refresh, ui.search, ui["new-note"], ui["search-form"].querySelector("button"),
  ]) {
    control.disabled = state.busy || !state.project;
  }
  ui.save.disabled = state.busy || !dirty() || (!state.note && !ui.title.value.trim());
}

async function run(action) {
  if (state.busy) return;
  state.busy = true;
  updateControls();
  showNotice();
  try {
    await action();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    state.busy = false;
    updateControls();
  }
}

function folderList(folders) {
  const list = document.createElement("ul");
  for (const folder of folders) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "folder";
    button.textContent = folder.directory_path === "/" ? "All notes" : folder.name;
    if (state.folder.directory_path === folder.directory_path && !state.query) {
      button.setAttribute("aria-current", "true");
    }
    button.addEventListener("click", () => {
      state.folder = folder;
      state.query = "";
      ui.search.value = "";
      renderLists();
    });
    item.append(button);
    const children = folder.children.filter(node => node.type === "directory");
    if (children.length) item.append(folderList(children));
    list.append(item);
  }
  return list;
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
  if (!state.folder) return;
  ui.folders.replaceChildren(folderList([state.tree]));
  const notes = (state.query ? state.results : (
    state.folder === state.tree ? allNotes(state.tree) : state.folder.children
  )).filter(isNote);
  if (!state.query) notes.sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
  ui["list-heading"].textContent = state.query ? "Search results" : (
    state.folder === state.tree ? "All notes" : state.folder.name
  );
  ui["list-detail"].textContent = state.query
    ? `“${state.query}” in ${state.project.name}`
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
    button.addEventListener("click", () => {
      if (note.external_id !== state.note?.external_id && canLeave()) {
        void run(() => openNote(note.external_id));
      }
    });
    item.append(button);
    ui["note-list"].append(item);
  }
  ui.more.hidden = !state.query || !state.hasMore;
  updateControls();
}

async function openNote(id) {
  const note = await request(projectUrl() + "/knowledge/entities/" + encodeURIComponent(id));
  if (typeof note.content !== "string") throw new Error("Markdown content is unavailable.");
  const html = await request("/preview", "POST", { markdown: note.content });
  state.note = note;
  state.draftFolder = null;
  state.editing = false;
  state.showSource = false;
  ui.preview.innerHTML = html;
  ui.markdown.value = note.content;
  state.baseline = ui.markdown.value;
  renderEditor();
  renderLists();
}

function renderEditor() {
  const draft = state.draftFolder !== null;
  const active = Boolean(state.note || draft);
  ui.empty.hidden = active;
  ui.preview.hidden = !active || state.showSource;
  ui.source.hidden = !state.showSource;
  ui.title.hidden = !draft;
  ui["title-label"].hidden = !draft;
  ui.mode.hidden = !draft && !state.note?.db_checksum;
  ui.mode.textContent = state.showSource ? "Preview" : "Edit Markdown";
  ui.cancel.hidden = !state.editing;
  ui.reload.hidden = !state.note;
  ui.save.hidden = !state.editing;
  ui["note-path"].textContent = state.note?.file_path ?? (draft ? "New note" : "Workspace");
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
  const tree = await request(projectUrl() + "/directory/tree");
  state.folder = findFolder(tree, state.folder.directory_path) ?? tree;
  state.tree = tree;
  renderLists();
}

async function selectProject(project, noteId) {
  const tree = await request(projectUrl(project) + "/directory/tree");
  state.project = project;
  ui.project.value = project.external_id;
  state.tree = tree;
  state.folder = tree;
  state.note = null;
  state.draftFolder = null;
  state.editing = false;
  state.showSource = false;
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
  if (start) await openNote(start.external_id);
}

async function saveNote() {
  const { note, draftFolder } = state;
  const title = note?.title ?? ui.title.value.trim();
  const content = ui.markdown.value || (note ? "" : `# ${title}\n`);
  const file = note?.file_path.split("/");
  const response = await request(projectUrl() + "/knowledge/write", "POST", {
    note: {
      title,
      content,
      directory: file ? file.slice(0, -1).join("/") : draftFolder.replace(/^\//, ""),
      file_name: file?.at(-1),
      note_type: note?.note_type ?? "note",
    },
    overwrite: Boolean(note),
    expected_checksum: note?.db_checksum,
  });
  const errors = {
    revision_conflict: "This note changed since you opened it. Your draft is still here. Copy your edits before reloading the note.",
    target_moved: "This note moved since you opened it. Your draft is still here.",
    already_exists: "A note with that name already exists in this folder.",
    locked: response.message || "This note is locked.",
  };
  if (!["created", "updated"].includes(response.kind)) {
    throw new Error(errors[response.kind] || "The note was not saved.");
  }
  // The accepted response is already committed. Keep the new revision even if the preview fails.
  state.note = response.entity;
  state.draftFolder = null;
  ui.markdown.value = state.note.content;
  state.baseline = ui.markdown.value;
  renderEditor();
  const html = await request("/preview", "POST", { markdown: state.note.content });
  state.editing = false;
  state.showSource = false;
  ui.preview.innerHTML = html;
  renderEditor();
  showNotice("Note saved.");
  try {
    await refreshTree();
    if (state.query) await search(state.query);
  } catch (error) {
    showNotice(`Note saved. Could not refresh the note list. ${error.message}`, true);
  }
}

ui["search-form"].addEventListener("submit", event => {
  event.preventDefault();
  if (state.project) void run(() => search(ui.search.value.trim()));
});
ui.more.addEventListener("click", () => void run(() => search(state.query, state.page + 1)));
ui.refresh.addEventListener("click", () => void run(async () => {
  await refreshTree();
  if (state.query) await search(state.query);
}));
ui["new-note"].addEventListener("click", () => {
  if (!canLeave()) return;
  showNotice();
  state.note = null;
  state.draftFolder = state.folder.directory_path;
  state.editing = true;
  state.showSource = true;
  ui.title.value = "";
  ui.markdown.value = "";
  renderEditor();
  renderLists();
  ui.title.focus();
});
ui.mode.addEventListener("click", () => {
  if (state.showSource) {
    void run(async () => {
      ui.preview.innerHTML = await request("/preview", "POST", { markdown: ui.markdown.value });
      state.showSource = false;
      renderEditor();
    });
  } else {
    state.editing = true;
    state.showSource = true;
    renderEditor();
    ui.markdown.focus();
  }
});
ui.preview.addEventListener("click", event => {
  const link = event.target.closest("[data-wikilink]");
  if (!link) return;
  event.preventDefault();
  if (state.busy || !canLeave()) return;
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
  });
});
ui.cancel.addEventListener("click", () => {
  if (!canLeave()) return;
  if (state.note) {
    void run(() => openNote(state.note.external_id));
  } else {
    state.draftFolder = null;
    state.editing = false;
    state.showSource = false;
    showNotice();
    renderEditor();
  }
});
ui.reload.addEventListener("click", () => {
  if (canLeave()) void run(() => openNote(state.note.external_id));
});
ui.save.addEventListener("click", () => void run(saveNote));
ui.title.addEventListener("input", updateControls);
ui.markdown.addEventListener("input", updateControls);
window.addEventListener("beforeunload", event => {
  if (dirty()) event.preventDefault();
});
document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !state.busy) {
    event.preventDefault();
    ui.search.focus();
  }
});

async function loadProjects() {
  const { projects } = await request("/v2/projects/");
  state.projects = projects;
  const current = projects.find(entry => entry.external_id === state.project?.external_id);
  ui.project.replaceChildren(...projects.map(project => new Option(project.name, project.external_id)));
  ui.project.value = current?.external_id ?? "";
  if (current) state.project = current;
  renderProjects();
}

function projectButton(label, project, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-label", `${label} ${project.name}`);
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
    const name = document.createElement("strong");
    name.textContent = project.name;
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
    actions.append(projectButton("Open", project, () => {
      if (project.external_id === state.project?.external_id) {
        ui["projects-dialog"].close();
      } else if (canLeave()) {
        void run(async () => {
          await selectProject(project);
          ui["projects-dialog"].close();
        });
      }
    }));
    if (!project.is_default) {
      actions.append(projectButton("Set default", project, () => void run(async () => {
        await request(projectUrl(project) + "/default", "PUT");
        await loadProjects();
        showNotice(`${project.name} is now the default project.`);
      })));
      actions.append(projectButton("Remove", project, () => {
        const isCurrent = project.external_id === state.project?.external_id;
        if (isCurrent && !canLeave()) return;
        if (!window.confirm(`Remove ${project.name} from Basic Memory? The Markdown files will stay in ${project.path}.`)) return;
        void run(async () => {
          await request(projectUrl(project), "DELETE");
          await loadProjects();
          if (isCurrent) await selectProject(state.projects.find(entry => entry.is_default) ?? state.projects[0]);
          showNotice(`${project.name} was removed. Its Markdown files were kept.`);
        });
      }));
    }
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
ui["manage-projects"].addEventListener("click", () => {
  ui["projects-dialog"].showModal();
  void run(loadProjects);
});
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
  if (!canLeave()) return;
  void run(async () => {
    const { new_project: project } = await request("/v2/projects/", "POST", {
      name, path, set_default: state.projects.length === 0,
    });
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
    await selectProject(state.projects.find(entry => entry.external_id === project.external_id));
    ui["projects-dialog"].close();
    showNotice(`Project ${name} is ready.`);
  });
});

ui.project.addEventListener("change", () => {
  const project = state.projects.find(entry => entry.external_id === ui.project.value);
  ui.project.value = state.project?.external_id ?? "";
  if (project && canLeave()) void run(() => selectProject(project));
});

void run(async () => {
  await loadProjects();
  const project = state.projects.find(entry => entry.is_default) ?? state.projects[0];
  if (project) await selectProject(project);
  else showNotice("Use Manage projects to add your first project.");
});
