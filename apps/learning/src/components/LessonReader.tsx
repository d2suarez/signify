"use client";

import { type Block, fileUrl, webLink } from "@/lib/blocks";
import { videoFromUrl, videoSrc } from "@/lib/post-doc";
import { boardLink } from "@/lib/boards";
import type { Dict } from "@/lib/i18n";
import { FileStage, VideoStage } from "./Presenter";

/**
 * A lesson read as one page, top to bottom: what a student opens from the
 * unit list or the class's Updates (and a teacher sees as "View as page").
 * Words, pictures, files, videos and links are shown; things that only work
 * live in class (polls, timers, pickers, the noise meter, outside tools)
 * are named as done in class.
 */
export default function LessonReader({ blocks, d }: { blocks: Block[]; d: Dict }) {
  if (!blocks.length) return <p className="empty">{d.readerEmpty}</p>;
  return (
    <div className="reader stack">
      {blocks.map((b) => <ReaderBlock key={b.id} b={b} d={d} />)}
    </div>
  );
}

function ReaderBlock({ b, d }: { b: Block; d: Dict }) {
  switch (b.type) {
    case "text":
      return (
        <section className="reader-text">
          {b.title && <h2>{b.title}</h2>}
          {b.body && <p>{b.body}</p>}
        </section>
      );
    case "file":
      // A picture at its own size (never wider than the page), opening the original; other files as on a slide.
      if (b.kind === "image" && b.fileId) {
        return (
          <figure className="reader-figure">
            <a href={fileUrl(b.fileId)} target="_blank" rel="noopener">
              {/* eslint-disable-next-line @next/next/no-img-element -- our own checked file, any size */}
              <img src={fileUrl(b.fileId)} alt={b.alt || b.title || b.name} loading="lazy" />
            </a>
            {b.title && b.title !== b.name && <figcaption className="muted">{b.title}</figcaption>}
          </figure>
        );
      }
      return <FileStage block={b} d={d} />;
    case "link": {
      const url = webLink(b.url);
      if (!url) return null;
      const v = videoFromUrl(url);
      if (v) return <VideoStage title={b.title} src={videoSrc(v)} url={url} provider={v.provider} d={d} />;
      return (
        <a className="reader-link card" href={url} target="_blank" rel="noopener noreferrer">
          <span className="grow" style={{ minWidth: 0 }}>
            <b>{b.title || d.blockLink}</b>
            <span className="muted" style={{ display: "block", fontSize: 13, overflowWrap: "anywhere" }}>{new URL(url).host}</span>
          </span>
          <span aria-hidden="true">↗</span>
        </a>
      );
    }
    case "board": {
      const link = boardLink(b.url);
      if (!link) return null;
      return (
        <a className="reader-link card" href={link.url} target="_blank" rel="noopener noreferrer">
          <span className="grow"><b>{b.title || d.blockBoard}</b></span><span aria-hidden="true">↗</span>
        </a>
      );
    }
    default:
      return <p className="reader-live muted">{d.readerInClass.replace("{what}", liveName(b, d))}</p>;
  }
}

function liveName(b: Block, d: Dict): string {
  switch (b.type) {
    case "poll": return d.blockPoll;
    case "timer": return d.blockTimer;
    case "picker": return d.blockPicker;
    case "noise": return d.blockNoise;
    case "tool": return b.title || d.blockTool;
    default: return "";
  }
}
