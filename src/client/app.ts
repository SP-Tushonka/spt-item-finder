import { ApiError, getHierarchy, getItem, getLocales } from "./api";
import { createAutocomplete, type Autocomplete } from "./autocomplete";
import { renderBreadcrumbs } from "./breadcrumbs";
import { copyToClipboard, renderJsonTree } from "./json-tree";
import { getLocale, setLocale } from "./prefs";
import type { ItemDetail } from "../shared/types";

const searchInput = document.getElementById("q") as HTMLInputElement;
const searchList = document.getElementById("q-list") as HTMLUListElement;
const localeSelect = document.getElementById("locale") as HTMLSelectElement;
const crumbsEl = document.getElementById("crumbs") as HTMLElement;
const detailEl = document.getElementById("detail") as HTMLElement;

const emptyStateHtml = detailEl.innerHTML;
let currentId: string | null = null;
let autocomplete: Autocomplete;

function navigate(id: string): void {
    history.pushState(null, "", `/item/${id}`);
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
    const match = location.pathname.match(/^\/item\/([^/]+)$/);
    if (match) {
        loadItem(decodeURIComponent(match[1]!));
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
        const [detail, hierarchy] = await Promise.all([
            getItem(id, locale),
            getHierarchy(id, locale),
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

    const tree = document.createElement("div");
    tree.className = "tree";
    renderJsonTree(tree, detail);
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

    autocomplete = createAutocomplete(searchInput, searchList, {
        getLocale: () => localeSelect.value || getLocale(),
        onSelect: navigate,
    });

    document.getElementById("brand")?.addEventListener("click", (event) => {
        event.preventDefault();
        goHome();
    });

    window.addEventListener("popstate", route);
    void populateLocales().then(route);
}

boot();
