import { searchItems } from "./api";
import type { SearchResult } from "../shared/types";

const ID_PATTERN = /^[a-z0-9]{24}$/;
const MIN_CHARS = 3;
const DEBOUNCE_MS = 250;

interface AutocompleteOptions {
    getLocale: () => string;
    getSptVersion: () => string;
    getMods: () => boolean;
    getDisabled: () => Set<number>;
    onSelect: (id: string) => void;
}

export interface Autocomplete {
    search: () => void;
}

export function createAutocomplete(
    input: HTMLInputElement,
    listbox: HTMLUListElement,
    opts: AutocompleteOptions,
): Autocomplete {
    let results: SearchResult[] = [];
    let active = -1;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    input.addEventListener("input", () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(query, DEBOUNCE_MS);
    });

    input.addEventListener("keydown", (event) => {
        if (listbox.hidden && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            if (results.length > 0) open();
            return;
        }
        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                setActive(active >= results.length - 1 ? 0 : active + 1);
                break;
            case "ArrowUp":
                event.preventDefault();
                setActive(active <= 0 ? results.length - 1 : active - 1);
                break;
            case "Enter":
                if (!listbox.hidden && results.length > 0) {
                    event.preventDefault();
                    select(active >= 0 ? active : 0);
                }
                break;
            case "Escape":
                close();
                break;
        }
    });

    input.addEventListener("focus", () => {
        if (results.length > 0 && input.value.trim().length >= MIN_CHARS) open();
    });

    input.addEventListener("blur", () => {
        // Grace period so a mousedown on an option can land first.
        setTimeout(close, 150);
    });

    async function query(): Promise<void> {
        const q = input.value.trim().toLowerCase();
        controller?.abort();

        if (ID_PATTERN.test(q)) {
            close();
            opts.onSelect(q);
            return;
        }
        if (q.length < MIN_CHARS) {
            results = [];
            close();
            return;
        }

        controller = new AbortController();
        try {
            const response = await searchItems(
                q,
                opts.getLocale(),
                opts.getSptVersion(),
                opts.getMods(),
                opts.getDisabled(),
                controller.signal,
            );
            results = response.results;
            render(results.length === 0 ? "No items match." : null);
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") return;
            results = [];
            render("Search failed. Is the server running?");
        }
    }

    function render(status: string | null): void {
        listbox.textContent = "";
        active = -1;

        if (status) {
            const li = document.createElement("li");
            li.className = "status";
            li.textContent = status;
            listbox.appendChild(li);
        }

        results.forEach((result, i) => {
            const li = document.createElement("li");
            li.id = `q-opt-${i}`;
            li.setAttribute("role", "option");

            const name = document.createElement("span");
            name.textContent = result.name;
            li.appendChild(name);

            if (result.shortName) {
                const short = document.createElement("span");
                short.className = "opt-short";
                short.textContent = result.shortName;
                li.appendChild(short);
            }

            if (result.mod) {
                const badge = document.createElement("span");
                badge.className = "opt-mod";
                badge.textContent = result.mod.name;
                badge.title = `Added by ${result.mod.name} ${result.mod.version} (SPT ${result.mod.sptVersion})`;
                li.appendChild(badge);
            }

            li.addEventListener("mousedown", (event) => event.preventDefault());
            li.addEventListener("click", () => select(i));
            listbox.appendChild(li);
        });

        open();
    }

    function setActive(index: number): void {
        active = index;
        listbox.querySelectorAll("li[role='option']").forEach((li, i) => {
            li.classList.toggle("active", i === index);
        });
        const activeEl = listbox.querySelector("li.active");
        activeEl?.scrollIntoView({ block: "nearest" });
        input.setAttribute("aria-activedescendant", activeEl?.id ?? "");
    }

    function select(index: number): void {
        const result = results[index];
        if (!result) return;
        input.value = result.name;
        close();
        opts.onSelect(result.id);
    }

    function open(): void {
        listbox.hidden = false;
        input.setAttribute("aria-expanded", "true");
    }

    function close(): void {
        listbox.hidden = true;
        input.setAttribute("aria-expanded", "false");
        input.setAttribute("aria-activedescendant", "");
    }

    return {
        search: () => {
            if (timer) clearTimeout(timer);
            void query();
        },
    };
}
