// Collapsible JSON tree. Containers render only a summary row up front; child
// DOM is built on first expand, which keeps huge item _props instant.

/** Value to the mod that contributed it, so a filter entry can name its source. */
let modded: Record<string, string> = {};
let expandAll = false;

export function renderJsonTree(
    container: HTMLElement,
    value: unknown,
    moddedValues: Record<string, string> = {},
    expanded = false,
): void {
    modded = moddedValues;
    expandAll = expanded;
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

    const fromMods = entries.filter(([, v]) => typeof v === "string" && modded[v]).length;
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
    if (expandAll ? entries.length > 0 : depth < 2 && key !== "_props" && entries.length > 0) {
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

    const source = typeof value === "string" ? modded[value] : undefined;
    const valueSpan = document.createElement("span");
    if (typeof value === "string") {
        valueSpan.className = "j-str";
        valueSpan.textContent = JSON.stringify(value);
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

    if (source) {
        row.classList.add("j-modded");
        const by = document.createElement("span");
        by.className = "j-modded-by";
        by.textContent = source;
        row.appendChild(by);
    }
    return row;
}

function copyButton(value: unknown): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "j-copy";
    button.textContent = "copy";
    button.title = "Copy this subtree as JSON";
    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        copyToClipboard(button, JSON.stringify(value, null, 2));
    });
    return button;
}

export function copyToClipboard(button: HTMLElement, text: string): void {
    navigator.clipboard.writeText(text).then(
        () => {
            button.classList.add("copied");
            const original = button.textContent;
            button.textContent = "copied";
            setTimeout(() => {
                button.classList.remove("copied");
                button.textContent = original;
            }, 1200);
        },
        () => {
            button.textContent = "copy failed";
        },
    );
}
