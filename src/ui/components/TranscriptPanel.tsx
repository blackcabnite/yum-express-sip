import { useEffect, useRef } from "react";
import type { TranscriptLine } from "@/domain/types";

interface Props {
  transcript: readonly TranscriptLine[];
}

export function TranscriptPanel({ transcript }: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript.length]);

  return (
    <section className="panel">
      <h2 className="panel-title">transcript</h2>
      <div className="transcript" ref={scrollRef}>
        {transcript.length === 0 ? (
          <p className="empty">no events yet</p>
        ) : (
          transcript.map((line) => (
            <p key={line.id} className={`tx-line tx-${line.speaker}`}>
              <span className="speaker">{labelFor(line.speaker)}</span>
              <span className="text">{line.text}</span>
            </p>
          ))
        )}
      </div>
    </section>
  );
}

function labelFor(speaker: TranscriptLine["speaker"]): string {
  return ({ ai: "AI", caller: "caller", system: "sys", tool: "tool" } as const)[speaker];
}
