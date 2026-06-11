"""Real audio event detection (DSP) — replaces the video-inference stub.

The audio sentinel previously *inferred* sound from the video scene (a placeholder
— there was no audio at all). This analyses ACTUAL audio: it extracts acoustic
features with librosa and classifies high-value security sounds by their physical
signature:

  - gunshot     : a loud, broadband, impulsive transient (sharp onset, high flatness)
  - glass_break : a high-frequency burst (very high spectral centroid + ZCR)
  - scream      : sustained, loud, high-pitched harmonic energy (low flatness)
  - alarm/siren : a sustained narrow-band tone (very low flatness, stable pitch)

Deterministic and dependency-light (librosa only). `classify()` is the pluggable
seam — a deep model (PANNs/YAMNet) can replace the heuristic later without
changing callers. Audio ingestion (ffmpeg from an RTSP audio track or a mic) is
provided but needs a real source; the analysis path is unit-tested on buffers.
"""
from __future__ import annotations

import io
import logging
from typing import Any, Dict, List, Optional

import numpy as np

logger = logging.getLogger(__name__)


def _features(y: np.ndarray, sr: int) -> Dict[str, float]:
    import librosa
    if y.size == 0:
        return {}
    y = y.astype(np.float32)
    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    onset = librosa.onset.onset_strength(y=y, sr=sr)

    # Spectral character is computed on the LOUDEST window, not averaged over the
    # whole (often mostly-silent) buffer — otherwise a short burst is diluted.
    seg = y
    if rms.size:
        peak_frame = int(np.argmax(rms))
        c = peak_frame * hop
        half = max(int(0.15 * sr), 256)
        seg = y[max(0, c - half): c + half]
        if seg.size < 256:
            seg = y

    cent = librosa.feature.spectral_centroid(y=seg, sr=sr)[0]
    flat = librosa.feature.spectral_flatness(y=seg)[0]
    zcr = librosa.feature.zero_crossing_rate(y=seg)[0]
    return {
        "peak_rms": float(np.max(rms)) if rms.size else 0.0,
        "mean_rms": float(np.mean(rms)) if rms.size else 0.0,
        "centroid_hz": float(np.mean(cent)),
        "flatness": float(np.mean(flat)),
        "zcr": float(np.mean(zcr)),
        "onset_peak": float(np.max(onset)) if onset.size else 0.0,
        "duration_s": float(len(y) / sr),
    }


class AudioDetectionService:
    # Loudness gate — ignore quiet ambient audio entirely.
    _RMS_GATE = 0.05

    def classify(self, y: np.ndarray, sr: int) -> List[Dict[str, Any]]:
        """Classify a mono audio buffer into security-relevant sound events."""
        f = _features(y, sr)
        if not f or f["peak_rms"] < self._RMS_GATE:
            return []

        events: List[Dict[str, Any]] = []
        peak, cent, flat, zcr, onset = (
            f["peak_rms"], f["centroid_hz"], f["flatness"], f["zcr"], f["onset_peak"]
        )

        # Very high-frequency burst → breaking glass (checked first; its high
        # centroid is the distinguishing signature vs a broadband gunshot).
        if cent >= 5000 and zcr >= 0.15:
            events.append({"label": "glass_break", "severity": "high",
                           "confidence": round(min(0.9, 0.4 + cent / 12000 + zcr), 2)})
        # Loud, broadband, impulsive → gunshot.
        elif peak >= 0.25 and flat >= 0.20 and onset >= 1.0:
            events.append({"label": "gunshot", "severity": "critical",
                           "confidence": round(min(0.95, 0.5 + flat + peak / 2), 2)})
        # Sustained, loud, high-pitched, harmonic → scream/shout.
        elif peak >= 0.15 and 1200 <= cent <= 4500 and flat < 0.12 and f["duration_s"] >= 0.4:
            events.append({"label": "scream", "severity": "high",
                           "confidence": round(min(0.9, 0.4 + peak), 2)})
        # Sustained narrow-band tone → alarm / siren.
        elif flat < 0.02 and f["mean_rms"] >= 0.1:
            events.append({"label": "alarm", "severity": "medium",
                           "confidence": round(min(0.9, 0.5 + (0.02 - flat) * 10), 2)})

        for e in events:
            e["features"] = {k: round(v, 4) for k, v in f.items()}
        return events

    def analyze_bytes(self, wav_bytes: bytes) -> List[Dict[str, Any]]:
        try:
            import soundfile as sf
            y, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32")
            if y.ndim > 1:
                y = y.mean(axis=1)  # mono
            return self.classify(y, sr)
        except Exception as exc:  # noqa: BLE001
            logger.warning("audio analyze_bytes failed: %s", exc)
            return []

    def extract_audio_from_rtsp(self, url: str, seconds: float = 3.0, sr: int = 16000) -> Optional[np.ndarray]:
        """Pull a few seconds of audio from an RTSP stream via ffmpeg (needs an
        audio track on the stream). Returns a mono float32 buffer, or None."""
        import subprocess
        try:
            proc = subprocess.run(
                ["ffmpeg", "-i", url, "-t", str(seconds), "-ac", "1", "-ar", str(sr),
                 "-f", "f32le", "-loglevel", "quiet", "pipe:1"],
                capture_output=True, timeout=seconds + 10,
            )
            if proc.returncode != 0 or not proc.stdout:
                return None
            return np.frombuffer(proc.stdout, dtype=np.float32)
        except Exception as exc:  # noqa: BLE001
            logger.debug("rtsp audio extract failed: %s", exc)
            return None


audio_detection_service = AudioDetectionService()
