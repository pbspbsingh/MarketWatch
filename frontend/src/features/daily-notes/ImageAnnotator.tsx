import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from "@mui/material";
import { Arrow, Image as KonvaImage, Layer, Line, Stage, Text } from "react-konva";
import type Konva from "konva";
import {
  fetchDailyNoteImageEdit,
  saveDailyNoteImageAnnotations,
  type ImageAnnotation,
  type ImageAnnotations,
} from "../../api/daily-notes";

type Tool = "select" | "arrow" | "line" | "text";

interface ImageAnnotatorProps {
  imageId: number;
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}

export function ImageAnnotator({ imageId, onClose, onSaved, onError }: ImageAnnotatorProps) {
  const [source, setSource] = useState<ImageBitmap>();
  const [loading, setLoading] = useState(true);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [viewportWidth, setViewportWidth] = useState(1);
  const [history, setHistory] = useState<ImageAnnotation[][]>([[]]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [savedState, setSavedState] = useState("[]");
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState("#ff3b30");
  const [stroke, setStroke] = useState(3);
  const [text, setText] = useState("Breakout");
  const [selected, setSelected] = useState(-1);
  const [drawing, setDrawing] = useState<ImageAnnotation>();
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const objects = history[historyIndex];
  const dirty = JSON.stringify(objects) !== savedState;
  const scale = Math.min(1, viewportWidth / size.width);
  const stageSize = useMemo(() => ({ width: size.width * scale, height: size.height * scale }), [scale, size]);

  useEffect(() => {
    const controller = new AbortController();
    let decoded: ImageBitmap | undefined;
    fetchDailyNoteImageEdit(imageId, controller.signal)
      .then(async (edit) => {
        const response = await fetch(edit.source_url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Failed to load annotation source: HTTP ${response.status}`);
        const image = await createImageBitmap(await response.blob());
        if (controller.signal.aborted) {
          image.close();
          return;
        }
        decoded = image;
        setSource(image);
        setSize({ width: edit.width, height: edit.height });
        setViewportWidth(Math.max(1, containerRef.current?.clientWidth ?? edit.width));
        setHistory([edit.annotations.objects]);
        setHistoryIndex(0);
        setSavedState(JSON.stringify(edit.annotations.objects));
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) onError(error);
      });
    return () => {
      controller.abort();
      decoded?.close();
    };
  }, [imageId]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const observer = new ResizeObserver(([entry]) => setViewportWidth(Math.max(1, entry.contentRect.width)));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const commit = (next: ImageAnnotation[]) => {
    setHistory((current) => [...current.slice(0, historyIndex + 1), next]);
    setHistoryIndex((index) => index + 1);
  };

  const pointer = () => {
    const point = stageRef.current?.getPointerPosition();
    return point === undefined || point === null ? undefined : {
      x: clamp(point.x / stageSize.width),
      y: clamp(point.y / stageSize.height),
    };
  };

  const startDrawing = (event: Konva.KonvaEventObject<PointerEvent>) => {
    if (event.target !== event.target.getStage()) return;
    setSelected(-1);
    const point = pointer();
    if (point === undefined || tool === "select") return;
    if (tool === "text") {
      if (text.trim() !== "") commit([...objects, { type: "text", ...point, text: text.slice(0, 200), color, size: 18 }]);
      return;
    }
    setDrawing({ type: tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y, color, width: stroke });
  };

  const continueDrawing = () => {
    const point = pointer();
    if (drawing === undefined || point === undefined || drawing.type === "text") return;
    setDrawing({ ...drawing, x2: point.x, y2: point.y });
  };

  const finishDrawing = () => {
    if (drawing !== undefined) commit([...objects, drawing]);
    setDrawing(undefined);
  };

  const move = (index: number, x: number, y: number) => {
    const object = objects[index];
    if (object === undefined) return;
    const next = [...objects];
    if (object.type === "text") {
      next[index] = { ...object, x: clamp(x / stageSize.width), y: clamp(y / stageSize.height) };
    } else {
      const dx = x / stageSize.width - object.x1;
      const dy = y / stageSize.height - object.y1;
      next[index] = { ...object, x1: clamp(object.x1 + dx), y1: clamp(object.y1 + dy), x2: clamp(object.x2 + dx), y2: clamp(object.y2 + dy) };
    }
    commit(next);
  };

  const close = () => {
    if (!dirty || window.confirm("Discard unsaved annotation changes?")) onClose();
  };

  const save = async () => {
    const stage = stageRef.current;
    if (stage === null) return;
    setSaving(true);
    try {
      setSelected(-1);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const canvas = stage.toCanvas({ pixelRatio: 1 / scale });
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (value) => value === null ? reject(new Error("Failed to encode annotation image")) : resolve(value),
        "image/webp",
        0.6,
      ));
      const annotations: ImageAnnotations = { version: 1, objects };
      await saveDailyNoteImageAnnotations(imageId, annotations, blob);
      setSavedState(JSON.stringify(objects));
      onSaved();
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  const displayed = drawing === undefined ? objects : [...objects, drawing];
  return (
    <Dialog open fullWidth maxWidth="xl" onClose={close}>
      <DialogTitle>Annotate image</DialogTitle>
      <DialogContent className="daily-note-annotator">
        <div className="daily-note-annotation-toolbar">
          {(["select", "arrow", "line", "text"] as Tool[]).map((value) => (
            <Button key={value} variant={tool === value ? "contained" : "outlined"} onClick={() => setTool(value)}>{value}</Button>
          ))}
          <input aria-label="Annotation color" type="color" value={color} onChange={(event) => setColor(event.target.value)} />
          <input aria-label="Stroke width" type="range" min="1" max="20" value={stroke} onChange={(event) => setStroke(Number(event.target.value))} />
          {tool === "text" && <input aria-label="Annotation text" maxLength={200} value={text} onChange={(event) => setText(event.target.value)} />}
          <Button disabled={historyIndex === 0} onClick={() => setHistoryIndex((index) => index - 1)}>Undo</Button>
          <Button disabled={historyIndex === history.length - 1} onClick={() => setHistoryIndex((index) => index + 1)}>Redo</Button>
          <Button disabled={selected < 0} color="error" onClick={() => {
            commit(objects.filter((_, index) => index !== selected));
            setSelected(-1);
          }}>Delete</Button>
        </div>
        <div ref={containerRef} className="daily-note-annotation-canvas">
          {loading && <span>Loading image…</span>}
          {source !== undefined && (
            <Stage ref={stageRef} width={stageSize.width} height={stageSize.height} onPointerDown={startDrawing} onPointerMove={continueDrawing} onPointerUp={finishDrawing}>
              <Layer>
                <KonvaImage image={source} width={stageSize.width} height={stageSize.height} listening={false} />
                {displayed.map((object, index) => object.type === "text" ? (
                  <Text key={index} x={object.x * stageSize.width} y={object.y * stageSize.height} text={object.text} fill={object.color} fontSize={object.size * scale} draggable={tool === "select"} stroke={selected === index ? "#4fc1ff" : undefined} strokeWidth={selected === index ? 1 : 0} onClick={() => setSelected(index)} onDragEnd={(event) => move(index, event.target.x(), event.target.y())} />
                ) : object.type === "arrow" ? (
                  <Arrow key={index} points={[object.x1 * stageSize.width, object.y1 * stageSize.height, object.x2 * stageSize.width, object.y2 * stageSize.height]} stroke={object.color} fill={object.color} strokeWidth={object.width * scale} pointerLength={12 * scale} pointerWidth={10 * scale} draggable={tool === "select"} shadowColor={selected === index ? "#4fc1ff" : undefined} shadowBlur={selected === index ? 5 : 0} onClick={() => setSelected(index)} onDragEnd={(event) => {
                    const x = object.x1 * stageSize.width + event.target.x();
                    const y = object.y1 * stageSize.height + event.target.y();
                    event.target.position({ x: 0, y: 0 });
                    move(index, x, y);
                  }} />
                ) : (
                  <Line key={index} points={[object.x1 * stageSize.width, object.y1 * stageSize.height, object.x2 * stageSize.width, object.y2 * stageSize.height]} stroke={object.color} strokeWidth={object.width * scale} draggable={tool === "select"} shadowColor={selected === index ? "#4fc1ff" : undefined} shadowBlur={selected === index ? 5 : 0} onClick={() => setSelected(index)} onDragEnd={(event) => {
                    const x = object.x1 * stageSize.width + event.target.x();
                    const y = object.y1 * stageSize.height + event.target.y();
                    event.target.position({ x: 0, y: 0 });
                    move(index, x, y);
                  }} />
                ))}
              </Layer>
            </Stage>
          )}
        </div>
      </DialogContent>
      <DialogActions><Button onClick={close}>Cancel</Button><Button variant="contained" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button></DialogActions>
    </Dialog>
  );
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));
