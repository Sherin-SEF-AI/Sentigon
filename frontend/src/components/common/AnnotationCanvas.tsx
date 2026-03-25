"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { Pencil, Square, ArrowRight, Type, Trash2, Undo2, Download } from "lucide-react";

type Tool = "draw" | "rect" | "arrow" | "text";
type Annotation = {
  id: string;
  tool: Tool;
  points: { x: number; y: number }[];
  color: string;
  text?: string;
};

interface AnnotationCanvasProps {
  /** Width of the canvas */
  width: number;
  /** Height of the canvas */
  height: number;
  /** Background image URL (optional) */
  backgroundImage?: string;
  /** Callback when annotations change */
  onChange?: (annotations: Annotation[]) => void;
  /** Callback to export annotated image */
  onExport?: (dataUrl: string) => void;
  /** Read-only mode */
  readOnly?: boolean;
}

const COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#ffffff"];

export default function AnnotationCanvas({
  width,
  height,
  backgroundImage,
  onChange,
  onExport,
  readOnly = false,
}: AnnotationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("rect");
  const [color, setColor] = useState(COLORS[0]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [current, setCurrent] = useState<Annotation | null>(null);

  // Load background image
  useEffect(() => {
    if (backgroundImage) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = backgroundImage;
      img.onload = () => {
        bgRef.current = img;
        redraw();
      };
    }
  }, [backgroundImage]); // eslint-disable-line react-hooks/exhaustive-deps

  const redraw = useCallback(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    // Draw background
    if (bgRef.current) {
      ctx.drawImage(bgRef.current, 0, 0, width, height);
    }

    // Draw annotations
    const allAnnotations = current ? [...annotations, current] : annotations;
    for (const ann of allAnnotations) {
      ctx.strokeStyle = ann.color;
      ctx.fillStyle = ann.color;
      ctx.lineWidth = 2;

      if (ann.tool === "draw" && ann.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(ann.points[0].x, ann.points[0].y);
        for (let i = 1; i < ann.points.length; i++) {
          ctx.lineTo(ann.points[i].x, ann.points[i].y);
        }
        ctx.stroke();
      } else if (ann.tool === "rect" && ann.points.length === 2) {
        const [p1, p2] = ann.points;
        ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
      } else if (ann.tool === "arrow" && ann.points.length === 2) {
        const [p1, p2] = ann.points;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        // Arrowhead
        const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        const headLen = 12;
        ctx.beginPath();
        ctx.moveTo(p2.x, p2.y);
        ctx.lineTo(p2.x - headLen * Math.cos(angle - 0.4), p2.y - headLen * Math.sin(angle - 0.4));
        ctx.lineTo(p2.x - headLen * Math.cos(angle + 0.4), p2.y - headLen * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fill();
      } else if (ann.tool === "text" && ann.text && ann.points.length > 0) {
        ctx.font = "14px sans-serif";
        ctx.fillText(ann.text, ann.points[0].x, ann.points[0].y);
      }
    }
  }, [annotations, current, width, height]);

  useEffect(() => { redraw(); }, [redraw]);

  const getPos = (e: React.MouseEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * width,
      y: ((e.clientY - rect.top) / rect.height) * height,
    };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (readOnly) return;
    const pos = getPos(e);

    if (tool === "text") {
      const text = prompt("Enter annotation text:");
      if (text) {
        const ann: Annotation = {
          id: `ann_${Date.now()}`,
          tool: "text",
          points: [pos],
          color,
          text,
        };
        setAnnotations((prev) => {
          const next = [...prev, ann];
          onChange?.(next);
          return next;
        });
      }
      return;
    }

    setDrawing(true);
    setCurrent({
      id: `ann_${Date.now()}`,
      tool,
      points: [pos],
      color,
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drawing || !current || readOnly) return;
    const pos = getPos(e);

    if (tool === "draw") {
      setCurrent((prev) => prev ? { ...prev, points: [...prev.points, pos] } : null);
    } else {
      setCurrent((prev) => prev ? { ...prev, points: [prev.points[0], pos] } : null);
    }
  };

  const handleMouseUp = () => {
    if (!drawing || !current) return;
    setDrawing(false);
    setAnnotations((prev) => {
      const next = [...prev, current];
      onChange?.(next);
      return next;
    });
    setCurrent(null);
  };

  const undo = () => {
    setAnnotations((prev) => {
      const next = prev.slice(0, -1);
      onChange?.(next);
      return next;
    });
  };

  const clear = () => {
    setAnnotations([]);
    onChange?.([]);
  };

  const exportImage = () => {
    const dataUrl = canvasRef.current?.toDataURL("image/png");
    if (dataUrl) onExport?.(dataUrl);
  };

  const tools: { id: Tool; icon: React.ReactNode; label: string }[] = [
    { id: "draw", icon: <Pencil className="h-3.5 w-3.5" />, label: "Draw" },
    { id: "rect", icon: <Square className="h-3.5 w-3.5" />, label: "Rectangle" },
    { id: "arrow", icon: <ArrowRight className="h-3.5 w-3.5" />, label: "Arrow" },
    { id: "text", icon: <Type className="h-3.5 w-3.5" />, label: "Text" },
  ];

  return (
    <div className="flex flex-col gap-2">
      {!readOnly && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-1.5">
          {tools.map((t) => (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
              className={`rounded-md p-1.5 transition-colors ${
                tool === t.id
                  ? "bg-cyan-900/40 text-cyan-400"
                  : "text-gray-500 hover:bg-gray-800 hover:text-gray-300"
              }`}
              title={t.label}
            >
              {t.icon}
            </button>
          ))}

          <div className="mx-2 h-4 w-px bg-gray-800" />

          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`h-4 w-4 rounded-full border-2 transition-transform ${
                color === c ? "border-white scale-125" : "border-gray-700"
              }`}
              style={{ backgroundColor: c }}
            />
          ))}

          <div className="mx-2 h-4 w-px bg-gray-800" />

          <button
            onClick={undo}
            disabled={annotations.length === 0}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300 disabled:opacity-30 transition-colors"
            title="Undo"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={clear}
            disabled={annotations.length === 0}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-800 hover:text-red-400 disabled:opacity-30 transition-colors"
            title="Clear All"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          {onExport && (
            <button
              onClick={exportImage}
              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-800 hover:text-cyan-400 transition-colors"
              title="Export Image"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="rounded-lg border border-gray-800 cursor-crosshair"
        style={{ width: "100%", height: "auto", maxHeight: height }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
    </div>
  );
}
