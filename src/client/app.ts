import {
    ApiError,
    getHierarchy,
    getItem,
    getModItems,
    getMods,
    getSptVersions,
    getLocales,
} from "./api";
import { createAutocomplete, type Autocomplete } from "./autocomplete";
import { renderBreadcrumbs } from "./breadcrumbs";
import { copyToClipboard, renderJsonTree } from "./json-tree";
import {
    getDisabledMods,
    getExpandAll,
    getSptVersion,
    getLocale,
    getModsEnabled,
    setDisabledMods,
    setExpandAll,
    setSptVersion,
    setLocale,
    setModsEnabled,
} from "./prefs";
import type { ImportedMod, ItemDetail } from "../shared/types";

const searchInput = document.getElementById("q") as HTMLInputElement;
const searchList = document.getElementById("q-list") as HTMLUListElement;
const localeSelect = document.getElementById("locale") as HTMLSelectElement;
const modsToggle = document.getElementById("mods") as HTMLInputElement;
const sptSelect = document.getElementById("spt") as HTMLSelectElement;
const expandToggle = document.getElementById("expand") as HTMLInputElement;
const crumbsEl = document.getElementById("crumbs") as HTMLElement;
const detailEl = document.getElementById("detail") as HTMLElement;

const emptyStateHtml = detailEl.innerHTML;
let currentId: string | null = null;
let autocomplete: Autocomplete;
let defaultSptVersion = "4.1";

/** Omitted for the default sptVersion so shared links keep their existing shape. */
function sptQuery(): string {
    return sptSelect.value && sptSelect.value !== defaultSptVersion
        ? `?spt=${encodeURIComponent(sptSelect.value)}`
        : "";
}

function navigate(id: string): void {
    history.pushState(null, "", `/item/${id}${sptQuery()}`);
    loadItem(id);
}

function goHome(): void {
    history.pushState(null, "", "/");
    showHome();
}

function showHome(): void {
    currentId = null;
    crumbsEl.hidden = true;
    crumbsEl.textContent = "";
    detailEl.innerHTML = emptyStateHtml;
    document.title = "SPT Item Finder";
    searchInput.value = "";
    searchInput.focus();
}

function showNotice(message: string): void {
    crumbsEl.hidden = true;
    detailEl.textContent = "";
    const notice = document.createElement("p");
    notice.className = "notice";
    notice.textContent = message;
    detailEl.appendChild(notice);
}

function route(): void {
    // A link carrying ?spt= views that version without overwriting the reader's own preference.
    const wanted = new URLSearchParams(location.search).get("spt");
    if (wanted && [...sptSelect.options].some((option) => option.value === wanted)) {
        sptSelect.value = wanted;
    }

    const match = location.pathname.match(/^\/item\/([^/]+)$/);
    if (match) {
        loadItem(decodeURIComponent(match[1]!));
        return;
    }
    if (location.pathname === "/mods") {
        loadMods();
        return;
    }
    showHome();

    const q = new URLSearchParams(location.search).get("q");
    if (q) {
        searchInput.value = q;
        autocomplete.search();
    }
}

async function loadItem(id: string): Promise<void> {
    currentId = id;
    showNotice("Loading…");

    const locale = localeSelect.value || getLocale();
    try {
        const sptVersion = sptSelect.value;
        const [detail, hierarchy] = await Promise.all([
            getItem(id, locale, sptVersion, getDisabledMods()),
            getHierarchy(id, locale, sptVersion),
        ]);
        if (currentId !== id) return; // a newer navigation won
        renderDetail(detail);
        renderBreadcrumbs(crumbsEl, hierarchy.chain, id, { onNavigate: navigate, onHome: goHome });
    } catch (err) {
        if (currentId !== id) return;
        if (err instanceof ApiError && err.status === 404) {
            showNotice(`No item has the ID ${id}. Check the ID and try again.`);
        } else {
            showNotice(
                `Could not load the item: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
}

function renderDetail(detail: ItemDetail): void {
    const name = detail.locale?.Name ?? detail.item._name;
    document.title = `${name} · SPT Item Finder`;

    detailEl.textContent = "";
    const card = document.createElement("article");
    card.className = "item-card";

    const head = document.createElement("header");
    head.className = "item-head";

    const titleWrap = document.createElement("div");
    const title = document.createElement("h1");
    title.textContent = name;
    titleWrap.appendChild(title);

    const subParts: string[] = [];
    if (detail.locale?.ShortName) subParts.push(detail.locale.ShortName);
    if (detail.item._name !== name) subParts.push(detail.item._name);
    if (detail.handbook)
        subParts.push(`handbook ${detail.handbook.Price.toLocaleString("en-US")} ₽`);
    const sub = document.createElement("p");
    sub.className = "item-sub";
    sub.textContent = subParts.join(" · ");
    titleWrap.appendChild(sub);
    head.appendChild(titleWrap);

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const copyId = document.createElement("button");
    copyId.type = "button";
    copyId.className = "chip";
    copyId.textContent = detail.item._id;
    copyId.title = "Copy the item ID";
    copyId.addEventListener("click", () => copyToClipboard(copyId, detail.item._id));
    actions.appendChild(copyId);

    const copyJson = document.createElement("button");
    copyJson.type = "button";
    copyJson.className = "chip";
    copyJson.textContent = "Copy JSON";
    copyJson.title = "Copy the full item JSON";
    copyJson.addEventListener("click", () =>
        copyToClipboard(copyJson, JSON.stringify(detail, null, 2)),
    );
    actions.appendChild(copyJson);

    head.appendChild(actions);
    card.appendChild(head);

    if (detail.mod) card.appendChild(renderProvenance(detail));

    const tree = document.createElement("div");
    tree.className = "tree";
    // The mod attribution drives the highlighting; it is not part of the item's data.
    const { moddedFilters, ...shown } = detail;
    renderJsonTree(tree, shown, moddedFilters, expandToggle.checked);
    card.appendChild(tree);

    detailEl.appendChild(card);
}

async function populateLocales(): Promise<void> {
    try {
        const { locales, default: fallback } = await getLocales();
        localeSelect.textContent = "";
        for (const code of locales) {
            const option = document.createElement("option");
            option.value = code;
            option.textContent = code;
            localeSelect.appendChild(option);
        }
        const preferred = getLocale();
        localeSelect.value = locales.includes(preferred) ? preferred : fallback;
    } catch {
        // Keep the static "en" option; searches still work if the server comes back.
    }
}

function boot(): void {
    localeSelect.addEventListener("change", () => {
        setLocale(localeSelect.value);
        if (currentId) loadItem(currentId);
    });

    sptSelect.addEventListener("change", () => {
        setSptVersion(sptSelect.value);
        if (currentId) {
            history.replaceState(null, "", `/item/${currentId}${sptQuery()}`);
            loadItem(currentId);
        } else if (location.pathname === "/mods") {
            loadMods();
        } else {
            autocomplete.search();
        }
    });

    expandToggle.checked = getExpandAll();
    expandToggle.addEventListener("change", () => {
        setExpandAll(expandToggle.checked);
        if (currentId) loadItem(currentId);
    });

    modsToggle.checked = getModsEnabled();
    modsToggle.addEventListener("change", () => {
        setModsEnabled(modsToggle.checked);
        if (location.pathname === "/mods") loadMods();
        else if (currentId) loadItem(currentId);
        else autocomplete.search();
    });

    autocomplete = createAutocomplete(searchInput, searchList, {
        getLocale: () => localeSelect.value || getLocale(),
        getSptVersion: () => sptSelect.value,
        getMods: () => modsToggle.checked,
        getDisabled: getDisabledMods,
        onSelect: navigate,
    });

    document.getElementById("mods-link")?.addEventListener("click", (event) => {
        event.preventDefault();
        history.pushState(null, "", "/mods");
        loadMods();
    });

    document.getElementById("brand")?.addEventListener("click", (event) => {
        event.preventDefault();
        goHome();
    });

    window.addEventListener("popstate", route);
    void Promise.all([populateLocales(), loadSptVersions()]).then(route);
}

boot();

function renderProvenance(detail: ItemDetail): HTMLElement {
    const mod = detail.mod!;
    const box = document.createElement("aside");
    box.className = "provenance";

    const sptVersion = document.createElement("p");
    sptVersion.className = "provenance-main";
    sptVersion.append("Added by ");
    const link = document.createElement("a");
    link.href = mod.detailUrl;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = mod.name;
    sptVersion.appendChild(link);
    box.appendChild(sptVersion);

    return box;
}

async function loadMods(): Promise<void> {
    currentId = null;
    searchInput.value = "";
    showNotice("Loading…");
    try {
        const { mods, totals } = await getMods(sptSelect.value);
        renderMods(mods, totals);
    } catch (err) {
        showNotice(`Could not load the mod list: ${err instanceof Error ? err.message : err}`);
    }
}

function cell(row: HTMLTableRowElement, text: string, className?: string): HTMLTableCellElement {
    const td = document.createElement("td");
    td.textContent = text;
    if (className) td.className = className;
    row.appendChild(td);
    return td;
}

function bulkButton(label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mods-bulk-button";
    button.textContent = label;
    return button;
}

function renderMods(mods: ImportedMod[], totals: { mods: number; items: number }): void {
    document.title = "Imported mods · SPT Item Finder";
    crumbsEl.hidden = true;
    detailEl.textContent = "";

    const card = document.createElement("article");
    card.className = "item-card";

    const head = document.createElement("header");
    head.className = "item-head";
    const titleWrap = document.createElement("div");
    const title = document.createElement("h1");
    title.textContent = "Imported mods";
    titleWrap.appendChild(title);
    const disabled = getDisabledMods();
    const modsOn = modsToggle.checked;
    const sub = document.createElement("p");
    sub.className = "item-sub";
    titleWrap.appendChild(sub);
    head.appendChild(titleWrap);

    const rowsByMod = new Map<number, HTMLTableRowElement[]>();
    const boxByMod = new Map<number, HTMLInputElement>();
    const selectAll = bulkButton("Select all");
    const deselectAll = bulkButton("Deselect all");

    // Toggling a mod changes nothing the server holds, so the table is patched rather than rebuilt.
    const refresh = (): void => {
        const off = mods.filter((mod) => disabled.has(mod.id)).length;
        sub.textContent = modsOn
            ? `${totals.mods} mods · ${totals.items.toLocaleString("en-US")} items` +
              (off > 0 ? ` · ${off} off` : "")
            : `${totals.mods} mods · switched off`;
        for (const [id, rows] of rowsByMod) {
            for (const row of rows) row.classList.toggle("mods-off", disabled.has(id));
            const box = boxByMod.get(id);
            if (box) box.checked = !disabled.has(id);
        }
        selectAll.disabled = !modsOn || off === 0;
        deselectAll.disabled = !modsOn || off === mods.length;
    };

    const setAll = (on: boolean): void => {
        // Mods absent from this SPT version keep whatever state they already had.
        for (const mod of mods) {
            if (on) disabled.delete(mod.id);
            else disabled.add(mod.id);
        }
        setDisabledMods(disabled);
        refresh();
    };
    selectAll.addEventListener("click", () => setAll(true));
    deselectAll.addEventListener("click", () => setAll(false));

    if (mods.length > 0) {
        const bulk = document.createElement("div");
        bulk.className = "mods-bulk";
        bulk.append(selectAll, deselectAll);
        head.appendChild(bulk);
    }
    card.appendChild(head);

    if (mods.length === 0) {
        refresh();
        const empty = document.createElement("p");
        empty.className = "notice";
        empty.textContent = "No mods have been imported yet.";
        card.appendChild(empty);
        detailEl.appendChild(card);
        return;
    }

    if (!modsOn) {
        const note = document.createElement("p");
        note.className = "mods-note";
        note.textContent = "Mods are off, so none of these are being served. Turn on Mods above.";
        card.appendChild(note);
    }

    const table = document.createElement("table");
    table.className = modsOn ? "mods-table" : "mods-table mods-table-off";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["On", "Mod", "Category", "SPT", "Version", "Items", "Read"]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const body = document.createElement("tbody");
    for (const mod of mods) {
        mod.sptVersions.forEach((sptVersion, index) => {
            const row = document.createElement("tr");
            if (index === 0) row.className = "mods-first";
            rowsByMod.set(mod.id, [...(rowsByMod.get(mod.id) ?? []), row]);

            // A mod on both SPT sptVersions gets one name spanning its rows, rather than a blank cell.
            if (index === 0) {
                const toggleCell = document.createElement("td");
                toggleCell.rowSpan = mod.sptVersions.length;
                const box = document.createElement("input");
                box.type = "checkbox";
                box.checked = !disabled.has(mod.id);
                box.disabled = !modsOn;
                box.title = modsOn
                    ? `Include ${mod.name} in search and on item pages`
                    : "Mods are switched off";
                box.addEventListener("change", () => {
                    if (box.checked) disabled.delete(mod.id);
                    else disabled.add(mod.id);
                    setDisabledMods(disabled);
                    refresh();
                });
                boxByMod.set(mod.id, box);
                toggleCell.appendChild(box);
                row.appendChild(toggleCell);

                const nameCell = document.createElement("td");
                nameCell.rowSpan = mod.sptVersions.length;

                const toggle = document.createElement("button");
                toggle.type = "button";
                toggle.className = "mods-expand";
                toggle.textContent = mod.name;
                toggle.title = `Show the items ${mod.name} adds`;
                nameCell.appendChild(toggle);

                const forge = document.createElement("a");
                forge.className = "mods-forge";
                forge.href = mod.detailUrl;
                forge.target = "_blank";
                forge.rel = "noreferrer noopener";
                forge.textContent = "Forge";
                nameCell.appendChild(forge);
                row.appendChild(nameCell);

                toggle.addEventListener("click", () => toggleItems(mod, body, row, toggle));

                const categoryCell = cell(row, mod.category ?? "—", "mods-dim");
                categoryCell.rowSpan = mod.sptVersions.length;
            }

            cell(row, sptVersion.sptVersion);
            cell(row, sptVersion.version);
            cell(row, sptVersion.items.toLocaleString("en-US"), "mods-num");
            const read = cell(row, sptVersion.approximate ? "branch" : "release", "mods-dim");
            read.title = sptVersion.approximate
                ? `Read from the mod's default branch on ${sptVersion.scannedAt.slice(0, 10)}`
                : `Read from the tagged release on ${sptVersion.scannedAt.slice(0, 10)}`;
            body.appendChild(row);
        });
    }
    table.appendChild(body);
    refresh();

    const scroll = document.createElement("div");
    scroll.className = "mods-scroll";
    scroll.appendChild(table);
    card.appendChild(scroll);
    detailEl.appendChild(card);
}

/** The versions actually indexed come from the server; the stored preference only picks one. */
async function loadSptVersions(): Promise<void> {
    try {
        const { sptVersions, default: fallback } = await getSptVersions();
        defaultSptVersion = fallback;
        if (sptVersions.length === 0) {
            sptSelect.hidden = true;
            return;
        }
        sptSelect.textContent = "";
        for (const sptVersion of sptVersions) {
            const option = document.createElement("option");
            option.value = sptVersion;
            option.textContent = `SPT ${sptVersion}`;
            sptSelect.appendChild(option);
        }
        const stored = getSptVersion();
        sptSelect.value = sptVersions.includes(stored)
            ? stored
            : sptVersions.includes(fallback)
              ? fallback
              : sptVersions[0]!;
    } catch {
        // Keep the static option; the server will fall back to its own default.
    }
}

/** Fetched on first open: a mod's item list is far too big to send with the page. */
async function toggleItems(
    mod: ImportedMod,
    body: HTMLTableSectionElement,
    after: HTMLTableRowElement,
    toggle: HTMLButtonElement,
): Promise<void> {
    const existing = body.querySelector<HTMLTableRowElement>(`tr[data-items="${mod.id}"]`);
    if (existing) {
        existing.remove();
        toggle.classList.remove("mods-open");
        return;
    }

    const row = document.createElement("tr");
    row.dataset.items = String(mod.id);
    const cell = document.createElement("td");
    cell.colSpan = 7;
    // A flex td drops out of the table's column sizing, so the list lives in a div inside it.
    const list = document.createElement("div");
    list.className = "mods-items";
    list.textContent = "Loading…";
    cell.appendChild(list);
    row.appendChild(cell);
    after.after(row);
    toggle.classList.add("mods-open");

    try {
        const { items } = await getModItems(mod.id, localeSelect.value, sptSelect.value);
        list.textContent = "";
        if (items.length === 0) {
            list.textContent = "No items on this SPT version.";
            return;
        }
        for (const item of items) {
            const link = document.createElement("a");
            link.className = "mod-item";
            link.href = `/item/${item.id}${sptQuery()}`;
            link.textContent = item.name;
            link.title = item.shortName ? `${item.shortName} · ${item.id}` : item.id;
            link.addEventListener("click", (event) => {
                event.preventDefault();
                navigate(item.id);
            });
            list.appendChild(link);
        }
    } catch (err) {
        list.textContent = `Could not load items: ${err instanceof Error ? err.message : err}`;
    }
}
