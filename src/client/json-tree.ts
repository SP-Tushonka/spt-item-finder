// Collapsible JSON tree. Containers render only a summary row up front; child
// DOM is built on first expand, which keeps huge item _props instant.

export interface TreeOptions {
    /** Value to the mod that contributed it, so a filter entry can name its source. */
    modded?: Record<string, string>;
    names?: Record<string, string>;
    expanded?: boolean;
    linkFor?: (id: string) => string;
    onNavigate?: (id: string) => void;
}

let options: TreeOptions = {};

export function renderJsonTree(container: HTMLElement, value: unknown, opts: TreeOptions): void {
    options = opts;
    container.textContent = "";
    container.appendChild(renderNode(null, value, 0));
}

function renderNode(key: string | null, value: unknown, depth: number): HTMLElement {
    if (value !== null && typeof value === "object") {
        return containerNode(key, value as Record<string, unknown> | unknown[], depth);
    }
    return primitiveRow(key, value);
}

function containerNode(
    key: string | null,
    value: Record<string, unknown> | unknown[],
    depth: number,
): HTMLElement {
    const isArray = Array.isArray(value);
    const entries = isArray
        ? (value as unknown[]).map((v, i) => [String(i), v] as const)
        : Object.entries(value);

    const details = document.createElement("details");
    const summary = document.createElement("summary");

    if (key !== null) {
        const keySpan = document.createElement("span");
        keySpan.className = "j-key";
        keySpan.textContent = key;
        summary.appendChild(keySpan);
        summary.appendChild(document.createTextNode(": "));
    }

    const preview = document.createElement("span");
    preview.className = "j-preview";
    preview.textContent = isArray
        ? `[…] ${entries.length} ${entries.length === 1 ? "item" : "items"}`
        : `{…} ${entries.length} ${entries.length === 1 ? "key" : "keys"}`;
    summary.appendChild(preview);

    const fromMods = entries.filter(([, v]) => typeof v === "string" && options.modded?.[v]).length;
    if (fromMods > 0) {
        const tag = document.createElement("span");
        tag.className = "j-modded-count";
        tag.textContent = `+${fromMods} from mods`;
        summary.appendChild(tag);
    }
    summary.appendChild(copyButton(value));
    details.appendChild(summary);

    const children = document.createElement("div");
    details.appendChild(children);

    let rendered = false;
    const renderChildren = () => {
        if (rendered) return;
        rendered = true;
        for (const [childKey, childValue] of entries) {
            children.appendChild(renderNode(childKey, childValue, depth + 1));
        }
    };

    details.addEventListener("toggle", () => {
        if (details.open) renderChildren();
    });

    // Shallow levels start expanded, except the huge _props bag.
    if (
        options.expanded ? entries.length > 0 : depth < 2 && key !== "_props" && entries.length > 0
    ) {
        renderChildren();
        details.open = true;
    }

    return details;
}

function primitiveRow(key: string | null, value: unknown): HTMLElement {
    const row = document.createElement("div");
    row.className = "j-row";

    if (key !== null) {
        const keySpan = document.createElement("span");
        keySpan.className = "j-key";
        keySpan.textContent = key;
        row.appendChild(keySpan);
        row.appendChild(document.createTextNode(": "));
    }

    const source = typeof value === "string" ? options.modded?.[value] : undefined;
    const name = typeof value === "string" ? options.names?.[value] : undefined;
    const valueSpan = document.createElement(name ? "a" : "span");
    if (typeof value === "string") {
        valueSpan.className = "j-str";
        valueSpan.textContent = JSON.stringify(value);
        if (name) linkTo(valueSpan as HTMLAnchorElement, value);
    } else if (typeof value === "number") {
        valueSpan.className = "j-num";
        valueSpan.textContent = String(value);
    } else if (typeof value === "boolean") {
        valueSpan.className = "j-bool";
        valueSpan.textContent = String(value);
    } else {
        valueSpan.className = "j-null";
        valueSpan.textContent = "null";
    }
    row.appendChild(valueSpan);

    if (name) {
        const label = document.createElement("span");
        label.className = "j-name";
        label.textContent = name;
        row.appendChild(label);
    }

    if (source) {
        row.classList.add("j-modded");
        const by = document.createElement("span");
        by.className = "j-modded-by";
        by.textContent = source;
        row.appendChild(by);
    }
    row.appendChild(copyButton(value));
    return row;
}

function linkTo(link: HTMLAnchorElement, id: string): void {
    link.href = options.linkFor?.(id) ?? `/item/${id}`;
    link.classList.add("j-link");
    link.addEventListener("click", (event) => {
        // Modified clicks keep their browser meaning, such as opening a new tab.
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        options.onNavigate?.(id);
    });
}

function copyButton(value: unknown): HTMLButtonElement {
    const container = value !== null && typeof value === "object";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "j-copy";
    button.title = container ? "Copy this subtree as JSON" : "Copy this value";
    button.setAttribute("aria-label", button.title);
    button.appendChild(icon("copy"));
    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        copyToClipboard(button, container ? JSON.stringify(value, null, 2) : String(value));
    });
    return button;
}

// Paths from Bootstrap Icons 1.11.3 (MIT): copy, check2 and x.
const ICONS = {
    copy: "M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1z",
    copied: "M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0",
    failed: "M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708",
};

function icon(name: keyof typeof ICONS): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("d", ICONS[name]);
    svg.appendChild(path);
    return svg;
}

// Kept per element so a second click mid-flash does not record the feedback as the label.
const labels = new WeakMap<HTMLElement, Node[]>();

export function copyToClipboard(button: HTMLElement, text: string): void {
    if (!labels.has(button)) labels.set(button, [...button.childNodes]);
    const original = labels.get(button)!;
    const iconOnly = button.classList.contains("j-copy");
    const flash = (copied: boolean) => {
        button.classList.toggle("copied", copied);
        if (iconOnly) button.replaceChildren(icon(copied ? "copied" : "failed"));
        else button.textContent = copied ? "copied" : "copy failed";
        setTimeout(() => {
            button.classList.remove("copied");
            button.replaceChildren(...original);
        }, 1200);
    };
    navigator.clipboard.writeText(text).then(
        () => flash(true),
        () => flash(false),
    );
}
