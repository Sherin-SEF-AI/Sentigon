"use client";

interface ConfidenceSliderProps {
  /** Current value (0-1) */
  value: number;
  /** Callback when value changes */
  onChange: (value: number) => void;
  /** Label */
  label?: string;
  /** Min value */
  min?: number;
  /** Max value */
  max?: number;
  /** Step */
  step?: number;
  /** Show percentage instead of decimal */
  showPercent?: boolean;
  /** Disabled */
  disabled?: boolean;
}

function confidenceColor(value: number): string {
  if (value >= 0.8) return "accent-emerald-500";
  if (value >= 0.5) return "accent-amber-500";
  return "accent-red-500";
}

function confidenceLabel(value: number): string {
  if (value >= 0.9) return "Very High";
  if (value >= 0.7) return "High";
  if (value >= 0.5) return "Medium";
  if (value >= 0.3) return "Low";
  return "Very Low";
}

export default function ConfidenceSlider({
  value,
  onChange,
  label = "Confidence Threshold",
  min = 0,
  max = 1,
  step = 0.05,
  showPercent = true,
  disabled = false,
}: ConfidenceSliderProps) {
  const displayValue = showPercent ? `${Math.round(value * 100)}%` : value.toFixed(2);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
          {label}
        </label>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono font-bold text-gray-300 tabular-nums">
            {displayValue}
          </span>
          <span className="text-[9px] text-gray-600">
            ({confidenceLabel(value)})
          </span>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        disabled={disabled}
        className={`w-full h-1.5 rounded-full appearance-none bg-gray-800 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${confidenceColor(value)}`}
      />
      <div className="flex justify-between text-[9px] text-gray-700">
        <span>{showPercent ? "0%" : min}</span>
        <span>{showPercent ? "100%" : max}</span>
      </div>
    </div>
  );
}
