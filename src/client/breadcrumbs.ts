import type { HierarchyNode } from "../shared/types";

interface BreadcrumbOptions {
    onNavigate: (id: string) => void;
    onHome: () => void;
}

export function renderBreadcrumbs(
    el: HTMLElement,
    chain: HierarchyNode[],
    currentId: string,
    opts: BreadcrumbOptions,
): void {
    el.textContent = "";
    el.hidden = false;

    const home = document.createElement("button");
    home.type = "button";
    home.textContent = "Home";
    home.addEventListener("click", opts.onHome);
    el.appendChild(home);

    for (const node of chain) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = "›";
        el.appendChild(sep);

        if (node.id === currentId) {
            const current = document.createElement("span");
            current.className = "current";
            current.textContent = node.name;
            el.appendChild(current);
        } else {
            const crumb = document.createElement("button");
            crumb.type = "button";
            crumb.textContent = node.name;
            crumb.addEventListener("click", () => opts.onNavigate(node.id));
            el.appendChild(crumb);
        }
    }
}
