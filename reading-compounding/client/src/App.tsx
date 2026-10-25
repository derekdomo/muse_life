import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api } from "./api";
import { Home } from "./Home";
import { Books } from "./Books";
import { Snippets } from "./Snippets";
import { Cards } from "./Cards";
import { Tags } from "./Tags";
import { Reader } from "./Reader";
import type { Book } from "./lib";

type Tab = "home" | "books" | "snippets" | "cards" | "tags";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "home", label: "回味" },
  { id: "books", label: "书单" },
  { id: "snippets", label: "片段" },
  { id: "cards", label: "知识卡" },
  { id: "tags", label: "主题" },
];

interface ReaderState {
  book: Book;
  chapter?: number;
  offset?: number;
}

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [reader, setReader] = useState<ReaderState | null>(null);
  const [focusSnippetId, setFocusSnippetId] = useState<number | null>(null);
  const [focusCardId, setFocusCardId] = useState<number | null>(null);

  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.getDashboard({}),
  });
  const library = useQuery({
    queryKey: ["library"],
    queryFn: () => api.getLibrary({}),
  });

  const forbidden =
    dashboard.data?.forbidden === true || library.data?.forbidden === true;

  const openReader = (book: Book, chapter?: number, offset?: number) =>
    setReader({ book, chapter, offset });

  const goSnippet = (id: number) => {
    setFocusSnippetId(id);
    setTab("snippets");
  };

  // Jump to one specific knowledge card by id (CMP-READ-001 receipt):
  // the cards tab scrolls to and highlights exactly that card.
  const goCard = (id: number) => {
    setFocusCardId(id);
    setTab("cards");
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto max-w-2xl px-4 pb-28 pt-4">
        {forbidden ? (
          <div className="py-16 text-center">
            <p className="font-serif-book text-xl">这本读书账只对所有者开放。</p>
            <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">
              当前身份未通过所有者校验，没有读取或写入任何内容。
              <br />
              以所有者身份打开后，这里会是你的书单、片段与知识卡复用账。
            </p>
          </div>
        ) : dashboard.isPending || library.isPending ? (
          <p className="py-16 text-center text-sm text-[var(--dim)]">正在打开书房…</p>
        ) : dashboard.error || library.error || !dashboard.data || !library.data ? (
          <div className="py-16 text-center">
            <p className="text-sm">加载失败。</p>
            <button
              type="button"
              onClick={() => {
                void dashboard.refetch();
                void library.refetch();
              }}
              className="mt-3 rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
            >
              重试
            </button>
          </div>
        ) : (
          <>
            {tab === "home" && (
              <Home
                dashboard={dashboard.data}
                library={library.data}
                onOpenReader={openReader}
                onGoSnippets={() => setTab("snippets")}
                onGoBooks={() => setTab("books")}
                onGoCards={() => setTab("cards")}
              />
            )}
            {tab === "books" && (
              <Books library={library.data} onOpenReader={(b) => openReader(b)} />
            )}
            {tab === "snippets" && (
              <Snippets
                library={library.data}
                focusId={focusSnippetId}
                onOpenReader={openReader}
                onViewCard={goCard}
              />
            )}
            {tab === "cards" && <Cards library={library.data} focusId={focusCardId} />}
            {tab === "tags" && (
              <Tags
                library={library.data}
                onGoSnippet={goSnippet}
                onGoCards={() => setTab("cards")}
              />
            )}
          </>
        )}
      </main>

      {!forbidden && (
        <nav
          aria-label="主要视图"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border)] bg-[var(--surface)] pb-safe"
        >
          <div className="mx-auto flex max-w-2xl">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => setTab(t.id)}
                className={`flex-1 py-3 text-sm ${
                  tab === t.id
                    ? "font-semibold text-[var(--accent)]"
                    : "text-[var(--dim)]"
                }`}
              >
                {tab === t.id ? "● " : ""}
                {t.label}
              </button>
            ))}
          </div>
        </nav>
      )}

      {reader && (
        <Reader
          book={reader.book}
          startChapter={reader.chapter}
          startOffset={reader.offset}
          onClose={() => setReader(null)}
        />
      )}
    </div>
  );
}
