import { memo, useMemo } from "react";
import { parseUnifiedDiff } from "@protocol/diff";
import type { DiffHunk, DiffLine } from "@protocol/ipc";

export const DiffLines = memo(function DiffLines({
  lines,
  onLineComment,
  commentFor,
}: {
  lines: DiffLine[];
  onLineComment?: (lineNo: number) => void;
  commentFor?: (lineNo: number) => string | undefined;
}) {
  return (
    <div className="diff-table">
      {lines.map((line, i) => {
        const anchor = line.newNo;
        const commented = anchor != null && commentFor?.(anchor);
        return (
          <div key={i} className={`diff-row diff-${line.kind}${commented ? " diff-row-commented" : ""}`}>
            <span className="diff-no">{line.oldNo ?? ""}</span>
            <span className="diff-no">{line.newNo ?? ""}</span>
            <span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
            <span className="diff-text">{line.text}</span>
            {onLineComment && line.kind !== "del" && anchor != null && (
              <button
                type="button"
                className="diff-comment-btn"
                title="添加行内评论"
                onClick={() => onLineComment(anchor)}
              >
                +
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
});

export function HunkView({
  hunk,
  onLineComment,
  commentFor,
}: {
  hunk: DiffHunk;
  onLineComment?: (lineNo: number) => void;
  commentFor?: (lineNo: number) => string | undefined;
}) {
  return (
    <div className="diff-hunk">
      {hunk.header && <div className="diff-hunk-header">{hunk.header}</div>}
      <DiffLines lines={hunk.lines} onLineComment={onLineComment} commentFor={commentFor} />
    </div>
  );
}

/** Renders a raw unified diff text (e.g. the edit tool's details.diff). */
export const RawDiff = memo(function RawDiff({ text }: { text: string }) {
  const files = useMemo(() => parseUnifiedDiff(text), [text]);
  const file = files[0];
  if (!file) {
    return <pre className="tool-output">{text.slice(0, 8000)}</pre>;
  }
  return (
    <div className="rawdiff">
      {file.hunks.map((hunk, i) => (
        <HunkView key={i} hunk={hunk} />
      ))}
      {file.hunks.length === 0 && (
        <div className="diff-empty">
          {file.additions > 0 || file.deletions > 0
            ? `+${file.additions} −${file.deletions}`
            : "无文本差异(二进制或纯元数据变更)"}
        </div>
      )}
    </div>
  );
});
