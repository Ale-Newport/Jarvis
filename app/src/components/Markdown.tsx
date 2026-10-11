import { isValidElement, memo, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternal } from "../lib/tauri";
import { CopyButton } from "./ui/CopyButton";

const remarkPlugins = [remarkGfm];

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function languageOf(node: ReactNode): string | null {
  if (isValidElement<{ className?: string }>(node)) {
    const m = /language-([\w-]+)/.exec(node.props.className ?? "");
    return m?.[1] ?? null;
  }
  if (Array.isArray(node)) {
    for (const n of node) {
      const l = languageOf(n);
      if (l) return l;
    }
  }
  return null;
}

function CodeBlock({ children }: ComponentProps<"pre">) {
  const text = nodeText(children).replace(/\n$/, "");
  const lang = languageOf(children);
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-line bg-code">
      <div className="flex h-8 items-center justify-between border-b border-line px-3 text-[11.5px] text-fg-3">
        <span className="font-mono">{lang ?? "text"}</span>
        <CopyButton text={text} label="Copy code" size={13} className="-mr-1.5" />
      </div>
      <pre className="m-0 overflow-x-auto px-3.5 py-3 font-mono text-[13px] leading-relaxed">{children}</pre>
    </div>
  );
}

const components: Components = {
  a({ href, children }) {
    return (
      <a
        href={href}
        title={href}
        rel="noreferrer noopener"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (href) void openExternal(href);
        }}
      >
        {children}
      </a>
    );
  },
  pre: CodeBlock,
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto rounded-xl border border-line">
        <table>{children}</table>
      </div>
    );
  },
  img({ src, alt }) {
    if (typeof src !== "string" || !/^(https?:|data:image\/)/i.test(src)) return null;
    return <img src={src} alt={alt ?? ""} referrerPolicy="no-referrer" loading="lazy" />;
  },
};

export const Markdown = memo(function Markdown({ text, compact }: { text: string; compact?: boolean }) {
  return (
    <div className={compact ? "md md-compact selectable" : "md selectable"}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
