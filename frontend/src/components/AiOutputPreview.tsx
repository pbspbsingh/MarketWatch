import { useEffect, useRef } from "react";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Typography } from "@mui/material";
import "./ai-output-preview.css";

export function AiOutputPreview({ content, status, expanded = false }: { content: string; status: string; expanded?: boolean }) {
  const previewRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  useEffect(() => {
    if (previewRef.current && followOutput.current) previewRef.current.scrollTop = previewRef.current.scrollHeight;
  }, [content]);
  return <details className="ai-output-preview" open={expanded || undefined} onToggle={(event) => {
    if (event.currentTarget.open && previewRef.current && followOutput.current) previewRef.current.scrollTop = previewRef.current.scrollHeight;
  }}>
    <summary><ExpandMoreRoundedIcon /><span>Live AI output</span><span className="ai-output-preview-label">{status}</span></summary>
    <div className="ai-output-preview-body" ref={previewRef} onScroll={(event) => {
      const element = event.currentTarget;
      followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
    }}><Typography component="pre">{content || "Waiting for the AI response…"}</Typography></div>
  </details>;
}
