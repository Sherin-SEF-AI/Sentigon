"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { apiFetch } from "@/lib/utils";

// Leaflet CSS must be imported
import "leaflet/dist/leaflet.css";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MapConfig {
  center: { lat: number; lng: number };
  zoom: number;
  tile_url: string;
  tile_attribution: string;
  max_zoom: number;
  geofences: Array<{
    id: string;
    name: string;
    type: string;
    polygon: Array<{ lat: number; lng: number }>;
    center: { lat: number; lng: number } | null;
    radius: number;
    color: string;
    opacity: number;
    active: boolean;
  }>;
  floor_plans: Array<{
    id: string;
    name: string;
    floor: number;
    building: string;
    image_url: string;
    bounds: number[][];
    cameras: Array<{
      id: number;
      lat: number;
      lng: number;
      name: string;
      status: string;
      heading?: number;
    }>;
    sensors: Array<{ id: string; lat: number; lng: number; type: string }>;
    doors: Array<{
      id: string;
      lat: number;
      lng: number;
      name: string;
      state: string;
    }>;
  }>;
  tracked_assets: Array<{
    id: string;
    name: string;
    type: string;
    position: { lat: number; lng: number } | null;
    speed: number;
    heading: number;
    status: string;
    battery: number | null;
    zone: string;
  }>;
}

interface HeatmapPoint {
  lat: number;
  lng: number;
  intensity: number; // 0-1
}

interface TrailPoint {
  lat: number;
  lng: number;
  timestamp?: string;
}

interface ViolationAlert {
  id: string;
  title: string;
  zone_id?: string;
  lat?: number;
  lng?: number;
}

interface GeofenceForm {
  name: string;
  alert_on_breach: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Haversine distance in metres between two lat/lng points */
function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Build SVG path for a camera FOV wedge.
 * Returns an SVG string centered at (cx, cy) with given radius and arc.
 */
function fovWedgeSvg(heading: number, radiusPx: number): string {
  const halfAngle = 45; // 90-degree arc → ±45° from heading
  const cx = radiusPx + 4;
  const cy = radiusPx + 4;
  const totalSize = (radiusPx + 4) * 2;

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  // SVG Y-axis is inverted → negate sin
  const startAngle = toRad(heading - halfAngle - 90);
  const endAngle = toRad(heading + halfAngle - 90);

  const x1 = cx + radiusPx * Math.cos(startAngle);
  const y1 = cy + radiusPx * Math.sin(startAngle);
  const x2 = cx + radiusPx * Math.cos(endAngle);
  const y2 = cy + radiusPx * Math.sin(endAngle);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalSize}" height="${totalSize}" style="overflow:visible;pointer-events:none;">
    <path d="M ${cx} ${cy} L ${x1} ${y1} A ${radiusPx} ${radiusPx} 0 0 1 ${x2} ${y2} Z"
      fill="rgba(6,182,212,0.15)" stroke="rgba(6,182,212,0.5)" stroke-width="1"/>
  </svg>`;
}

/** Convert heatmap intensity (0-1) to a CSS color */
function intensityColor(intensity: number): string {
  if (intensity >= 0.7) return "rgba(239,68,68,";   // red
  if (intensity >= 0.35) return "rgba(234,179,8,";  // yellow
  return "rgba(34,197,94,";                          // green
}

/** Lerp a color channel */
function lerpChannel(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t);
}

/** Trail gradient color: 0=gray, 1=cyan */
function trailColor(t: number): string {
  const r = lerpChannel(107, 6, t);
  const g = lerpChannel(114, 182, t);
  const b = lerpChannel(128, 212, t);
  return `rgb(${r},${g},${b})`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function FacilityMap() {
  // ── Map refs ──────────────────────────────────────────────────
  const mapRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const layerGroupRef = useRef<any>(null);
  const heatLayerGroupRef = useRef<any>(null);
  const trailLayerGroupRef = useRef<any>(null);
  const violationLayerGroupRef = useRef<any>(null);
  const drawLayerGroupRef = useRef<any>(null);
  const measureLayerGroupRef = useRef<any>(null);
  const tileLayerRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);

  // ── Config & loading ──────────────────────────────────────────
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Layer toggles ─────────────────────────────────────────────
  const [showGeofences, setShowGeofences] = useState(true);
  const [showAssets, setShowAssets] = useState(true);
  const [showCameras, setShowCameras] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showViolations, setShowViolations] = useState(true);

  // ── Feature state ─────────────────────────────────────────────
  const [heatmapPoints, setHeatmapPoints] = useState<HeatmapPoint[]>([]);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [activeTrailAssetId, setActiveTrailAssetId] = useState<string | null>(
    null
  );
  const [violations, setViolations] = useState<ViolationAlert[]>([]);

  // Draw mode
  const [drawMode, setDrawMode] = useState(false);
  const drawVerticesRef = useRef<{ lat: number; lng: number }[]>([]);
  const drawPolylineRef = useRef<any>(null);
  const [geofenceForm, setGeofenceForm] = useState<GeofenceForm>({
    name: "",
    alert_on_breach: true,
  });
  const [drawComplete, setDrawComplete] = useState(false);
  const [savingGeofence, setSavingGeofence] = useState(false);

  // Measure mode
  const [measureMode, setMeasureMode] = useState(false);
  const measurePointsRef = useRef<{ lat: number; lng: number }[]>([]);
  const [measureDistance, setMeasureDistance] = useState<number | null>(null);

  // Asset search
  const [assetSearch, setAssetSearch] = useState("");

  // Cluster zoom tracking
  const [currentZoom, setCurrentZoom] = useState<number>(15);

  // User location
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [trackingLocation, setTrackingLocation] = useState(false);
  const userMarkerRef = useRef<any>(null);
  const userAccuracyRef = useRef<any>(null);
  const watchIdRef = useRef<number | null>(null);

  // ── Dark tile URL ─────────────────────────────────────────────
  const DARK_TILE_URL =
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
  const DARK_TILE_ATTR =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

  /* ---------------------------------------------------------------- */
  /*  Data fetching                                                    */
  /* ---------------------------------------------------------------- */

  // Fetch map config (poll every 10s)
  useEffect(() => {
    let cancelled = false;
    async function loadConfig() {
      try {
        const data = await apiFetch<MapConfig>("/api/gis/config");
        if (!cancelled) {
          setConfig(data);
          setError(null);
        }
      } catch (err) {
        console.error("Failed to load map config:", err);
        if (!cancelled) setError("Failed to load map configuration");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    loadConfig();
    const interval = setInterval(loadConfig, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Fetch heatmap data when toggle is enabled
  useEffect(() => {
    if (!showHeatmap) return;
    let cancelled = false;
    async function loadHeatmap() {
      setHeatmapLoading(true);
      try {
        const data = await apiFetch<HeatmapPoint[]>(
          "/api/gis/heatmap/activity"
        );
        if (!cancelled) setHeatmapPoints(data ?? []);
      } catch {
        if (!cancelled) setHeatmapPoints([]);
      } finally {
        if (!cancelled) setHeatmapLoading(false);
      }
    }
    loadHeatmap();
    return () => {
      cancelled = true;
    };
  }, [showHeatmap]);

  // Fetch violations
  useEffect(() => {
    let cancelled = false;
    async function loadViolations() {
      try {
        const data = await apiFetch<ViolationAlert[]>(
          "/api/alerts?status=new&limit=20"
        );
        if (!cancelled) setViolations(data ?? []);
      } catch {
        if (!cancelled) setViolations([]);
      }
    }
    loadViolations();
    const interval = setInterval(loadViolations, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Fetch trail for a specific asset
  const fetchAndShowTrail = useCallback(
    async (assetId: string) => {
      if (!mapRef.current || !leafletRef.current) return;
      const L = leafletRef.current;

      // Clear existing trail
      if (trailLayerGroupRef.current)
        trailLayerGroupRef.current.clearLayers();

      setActiveTrailAssetId(assetId);
      try {
        const trail = await apiFetch<TrailPoint[]>(
          `/api/gis/assets/${assetId}/trail`
        );
        if (!trail || trail.length < 2) return;

        const points = trail.slice(-50);
        const lg = trailLayerGroupRef.current;
        if (!lg) return;

        // Draw gradient polyline as segments
        for (let i = 0; i < points.length - 1; i++) {
          const t = i / (points.length - 1);
          const color = trailColor(t);
          L.polyline(
            [
              [points[i].lat, points[i].lng],
              [points[i + 1].lat, points[i + 1].lng],
            ],
            { color, weight: 3, opacity: 0.85 }
          ).addTo(lg);
        }

        // Pan to last known position
        const last = points[points.length - 1];
        mapRef.current.panTo([last.lat, last.lng]);
      } catch {
        // Fail silently
      }
    },
    []
  );

  const clearTrail = useCallback(() => {
    if (trailLayerGroupRef.current)
      trailLayerGroupRef.current.clearLayers();
    setActiveTrailAssetId(null);
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Map initialization                                               */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!config || !mapContainerRef.current || mapRef.current) return;

    const initMap = async () => {
      const L = await import("leaflet");
      leafletRef.current = L;

      // Fix default marker icon paths (webpack/Next.js asset issue)
      delete (L.Icon.Default.prototype as any)._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl:
          "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl:
          "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl:
          "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      });

      // Try to get user's current location for initial map center
      let initialCenter: [number, number] = [config.center.lat, config.center.lng];
      let initialZoom = config.zoom;
      try {
        if ("geolocation" in navigator) {
          const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: true,
              timeout: 5000,
              maximumAge: 60000,
            })
          );
          initialCenter = [pos.coords.latitude, pos.coords.longitude];
          initialZoom = 16; // Closer zoom when using current location
          setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        }
      } catch {
        // Geolocation denied/unavailable — use config center
      }

      const map = L.map(mapContainerRef.current!, {
        center: initialCenter,
        zoom: initialZoom,
        maxZoom: config.max_zoom,
        zoomControl: false,
      });

      // Add zoom control top-left
      L.control.zoom({ position: "topleft" }).addTo(map);

      // Dark tile layer
      const tile = L.tileLayer(DARK_TILE_URL, {
        attribution: DARK_TILE_ATTR,
        maxZoom: config.max_zoom || 19,
      }).addTo(map);
      tileLayerRef.current = tile;

      // Layer groups
      layerGroupRef.current = L.layerGroup().addTo(map);
      heatLayerGroupRef.current = L.layerGroup().addTo(map);
      trailLayerGroupRef.current = L.layerGroup().addTo(map);
      violationLayerGroupRef.current = L.layerGroup().addTo(map);
      drawLayerGroupRef.current = L.layerGroup().addTo(map);
      measureLayerGroupRef.current = L.layerGroup().addTo(map);

      mapRef.current = map;
      setCurrentZoom(map.getZoom());

      // Zoom change tracking
      map.on("zoomend", () => setCurrentZoom(map.getZoom()));

      // Show user location marker if we got GPS
      if (initialCenter[0] !== config.center.lat || initialCenter[1] !== config.center.lng) {
        const pulseIcon = L.divIcon({
          className: "",
          html: `<div style="position:relative;width:20px;height:20px;">
            <div style="position:absolute;width:20px;height:20px;border-radius:50%;background:rgba(59,130,246,0.3);animation:pulseLocation 2s ease-out infinite;"></div>
            <div style="position:absolute;top:4px;left:4px;width:12px;height:12px;border-radius:50%;background:#3b82f6;border:2px solid white;box-shadow:0 0 6px rgba(59,130,246,0.8);"></div>
          </div>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        });
        userMarkerRef.current = L.marker(initialCenter, { icon: pulseIcon, zIndexOffset: 9999 })
          .addTo(map)
          .bindPopup(`<b>Your Location</b><br>Lat: ${initialCenter[0].toFixed(6)}<br>Lng: ${initialCenter[1].toFixed(6)}`);
        setTrackingLocation(true);
      }

      renderLayers(map, L, config);
    };

    initMap();

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        layerGroupRef.current = null;
        heatLayerGroupRef.current = null;
        trailLayerGroupRef.current = null;
        violationLayerGroupRef.current = null;
        drawLayerGroupRef.current = null;
        measureLayerGroupRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config !== null]);

  /* ---------------------------------------------------------------- */
  /*  Re-render base layers on toggle / config change                  */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!mapRef.current || !leafletRef.current || !config) return;
    renderLayers(mapRef.current, leafletRef.current, config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showGeofences, showAssets, showCameras, config, assetSearch, currentZoom]);

  /* ---------------------------------------------------------------- */
  /*  Heatmap layer                                                    */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!leafletRef.current || !heatLayerGroupRef.current) return;
    const L = leafletRef.current;
    heatLayerGroupRef.current.clearLayers();
    if (!showHeatmap || heatmapPoints.length === 0) return;

    heatmapPoints.forEach((pt) => {
      const radius = 20 + pt.intensity * 30;
      const colorBase = intensityColor(pt.intensity);
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:${radius * 2}px;height:${radius * 2}px;border-radius:50%;background:${colorBase}${(pt.intensity * 0.6 + 0.1).toFixed(2)});border:none;pointer-events:none;"></div>`,
        iconSize: [radius * 2, radius * 2],
        iconAnchor: [radius, radius],
      });
      L.marker([pt.lat, pt.lng], { icon, interactive: false }).addTo(
        heatLayerGroupRef.current
      );
    });
  }, [showHeatmap, heatmapPoints]);

  /* ---------------------------------------------------------------- */
  /*  Violation markers (pulsing red)                                  */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!leafletRef.current || !violationLayerGroupRef.current) return;
    const L = leafletRef.current;
    violationLayerGroupRef.current.clearLayers();
    if (!showViolations || violations.length === 0) return;

    violations.forEach((alert) => {
      const hasCoords =
        (alert.lat !== undefined && alert.lng !== undefined) ||
        alert.zone_id !== undefined;
      if (!hasCoords) return;

      // Use alert coords directly; zone_id-based lookup would require
      // a separate API call — skip silently if no coords provided
      if (alert.lat === undefined || alert.lng === undefined) return;

      const icon = L.divIcon({
        className: "",
        html: `<div title="${alert.title}" style="width:18px;height:18px;border-radius:50%;background:#ef4444;border:2px solid #fca5a5;box-shadow:0 0 0 0 rgba(239,68,68,0.7);animation:pulseRed 1.4s infinite;cursor:pointer;"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });

      L.marker([alert.lat, alert.lng], { icon })
        .addTo(violationLayerGroupRef.current)
        .bindPopup(
          `<b style="color:#ef4444">⚠ Alert</b><br/>${alert.title}`
        );
    });
  }, [showViolations, violations]);

  /* ---------------------------------------------------------------- */
  /*  Draw mode — map click handler                                    */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L) return;

    if (!drawMode) {
      // Reset draw state
      if (drawPolylineRef.current) {
        drawLayerGroupRef.current?.removeLayer(drawPolylineRef.current);
        drawPolylineRef.current = null;
      }
      drawLayerGroupRef.current?.clearLayers();
      drawVerticesRef.current = [];
      map.getContainer().style.cursor = "";
      return;
    }

    map.getContainer().style.cursor = "crosshair";

    function handleClick(e: any) {
      if (drawComplete) return;
      const pt = { lat: e.latlng.lat, lng: e.latlng.lng };
      drawVerticesRef.current = [...drawVerticesRef.current, pt];

      // Redraw preview polyline
      if (drawPolylineRef.current)
        drawLayerGroupRef.current?.removeLayer(drawPolylineRef.current);

      const latlngs = drawVerticesRef.current.map(
        (v) => [v.lat, v.lng] as [number, number]
      );
      drawPolylineRef.current = L.polyline(latlngs, {
        color: "#06b6d4",
        weight: 2,
        dashArray: "6 4",
      }).addTo(drawLayerGroupRef.current);

      // Vertex dot
      const dotIcon = L.divIcon({
        className: "",
        html: `<div style="width:8px;height:8px;border-radius:50%;background:#06b6d4;border:2px solid white;"></div>`,
        iconSize: [8, 8],
        iconAnchor: [4, 4],
      });
      L.marker([pt.lat, pt.lng], { icon: dotIcon }).addTo(
        drawLayerGroupRef.current
      );
    }

    function handleDblClick(e: any) {
      if (drawVerticesRef.current.length < 3) return;
      // Close polygon preview
      const latlngs = drawVerticesRef.current.map(
        (v) => [v.lat, v.lng] as [number, number]
      );
      if (drawPolylineRef.current)
        drawLayerGroupRef.current?.removeLayer(drawPolylineRef.current);
      L.polygon(latlngs, {
        color: "#06b6d4",
        fillColor: "#06b6d4",
        fillOpacity: 0.15,
        weight: 2,
      }).addTo(drawLayerGroupRef.current);
      setDrawComplete(true);
      map.getContainer().style.cursor = "";
    }

    map.on("click", handleClick);
    map.on("dblclick", handleDblClick);

    return () => {
      map.off("click", handleClick);
      map.off("dblclick", handleDblClick);
      map.getContainer().style.cursor = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawMode, drawComplete]);

  /* ---------------------------------------------------------------- */
  /*  Measure mode — map click handler                                 */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L) return;

    if (!measureMode) {
      measureLayerGroupRef.current?.clearLayers();
      measurePointsRef.current = [];
      setMeasureDistance(null);
      map.getContainer().style.cursor = "";
      return;
    }

    map.getContainer().style.cursor = "crosshair";

    function handleClick(e: any) {
      const pts = measurePointsRef.current;
      if (pts.length >= 2) {
        // Reset for new measurement
        measureLayerGroupRef.current?.clearLayers();
        measurePointsRef.current = [];
        setMeasureDistance(null);
      }

      const pt = { lat: e.latlng.lat, lng: e.latlng.lng };
      measurePointsRef.current = [...measurePointsRef.current, pt];

      const dotIcon = L.divIcon({
        className: "",
        html: `<div style="width:10px;height:10px;border-radius:50%;background:#f59e0b;border:2px solid white;"></div>`,
        iconSize: [10, 10],
        iconAnchor: [5, 5],
      });
      L.marker([pt.lat, pt.lng], { icon: dotIcon }).addTo(
        measureLayerGroupRef.current
      );

      if (measurePointsRef.current.length === 2) {
        const [p1, p2] = measurePointsRef.current;
        const dist = haversineMeters(p1.lat, p1.lng, p2.lat, p2.lng);
        setMeasureDistance(dist);

        L.polyline(
          [
            [p1.lat, p1.lng],
            [p2.lat, p2.lng],
          ],
          { color: "#f59e0b", weight: 2, dashArray: "6 3" }
        ).addTo(measureLayerGroupRef.current);

        // Mid-point label
        const midLat = (p1.lat + p2.lat) / 2;
        const midLng = (p1.lng + p2.lng) / 2;
        const labelIcon = L.divIcon({
          className: "",
          html: `<div style="background:#1e293b;color:#f59e0b;font-size:11px;padding:2px 6px;border-radius:4px;white-space:nowrap;border:1px solid #f59e0b;">${dist >= 1000 ? (dist / 1000).toFixed(2) + " km" : Math.round(dist) + " m"}</div>`,
          iconSize: [80, 20],
          iconAnchor: [40, 10],
        });
        L.marker([midLat, midLng], { icon: labelIcon, interactive: false }).addTo(
          measureLayerGroupRef.current
        );
      }
    }

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
      map.getContainer().style.cursor = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureMode]);

  /* ---------------------------------------------------------------- */
  /*  Geolocation — track user's current position                      */
  /* ---------------------------------------------------------------- */

  const startLocationTracking = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setLocationError("Geolocation not supported by browser");
      return;
    }
    setTrackingLocation(true);
    setLocationError(null);

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const loc = { lat: position.coords.latitude, lng: position.coords.longitude };
        setUserLocation(loc);
        setLocationError(null);

        const map = mapRef.current;
        const L = leafletRef.current;
        if (!map || !L) return;

        // Update or create user marker (pulsing blue dot)
        if (userMarkerRef.current) {
          userMarkerRef.current.setLatLng([loc.lat, loc.lng]);
        } else {
          const pulseIcon = L.divIcon({
            className: "",
            html: `<div style="position:relative;width:20px;height:20px;">
              <div style="position:absolute;width:20px;height:20px;border-radius:50%;background:rgba(59,130,246,0.3);animation:pulseLocation 2s ease-out infinite;"></div>
              <div style="position:absolute;top:4px;left:4px;width:12px;height:12px;border-radius:50%;background:#3b82f6;border:2px solid white;box-shadow:0 0 6px rgba(59,130,246,0.8);"></div>
            </div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          });
          userMarkerRef.current = L.marker([loc.lat, loc.lng], { icon: pulseIcon, zIndexOffset: 9999 })
            .addTo(map)
            .bindPopup(`<b>Your Location</b><br>Lat: ${loc.lat.toFixed(6)}<br>Lng: ${loc.lng.toFixed(6)}`);
        }

        // Update accuracy circle
        const accuracy = position.coords.accuracy;
        if (userAccuracyRef.current) {
          userAccuracyRef.current.setLatLng([loc.lat, loc.lng]);
          userAccuracyRef.current.setRadius(accuracy);
        } else {
          userAccuracyRef.current = L.circle([loc.lat, loc.lng], {
            radius: accuracy,
            color: "#3b82f6",
            fillColor: "#3b82f6",
            fillOpacity: 0.1,
            weight: 1,
            interactive: false,
          }).addTo(map);
        }
      },
      (error) => {
        setLocationError(
          error.code === 1 ? "Location permission denied" :
          error.code === 2 ? "Location unavailable" :
          error.code === 3 ? "Location request timed out" :
          "Location error"
        );
        setTrackingLocation(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
    watchIdRef.current = watchId;
  }, []);

  const stopLocationTracking = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setTrackingLocation(false);
    // Remove markers
    if (userMarkerRef.current) {
      userMarkerRef.current.remove();
      userMarkerRef.current = null;
    }
    if (userAccuracyRef.current) {
      userAccuracyRef.current.remove();
      userAccuracyRef.current = null;
    }
    setUserLocation(null);
  }, []);

  const panToMyLocation = useCallback(() => {
    if (userLocation && mapRef.current) {
      mapRef.current.setView([userLocation.lat, userLocation.lng], 18);
    }
  }, [userLocation]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  // Inject pulse animation CSS
  useEffect(() => {
    if (typeof document === "undefined") return;
    const styleId = "sentinel-location-pulse";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `@keyframes pulseLocation{0%{transform:scale(1);opacity:0.7}100%{transform:scale(3);opacity:0}}`;
      document.head.appendChild(style);
    }
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Save geofence                                                    */
  /* ---------------------------------------------------------------- */

  const saveGeofence = useCallback(async () => {
    if (drawVerticesRef.current.length < 3) return;
    setSavingGeofence(true);
    try {
      await apiFetch("/api/gis/geofences", {
        method: "POST",
        body: JSON.stringify({
          name: geofenceForm.name || "New Geofence",
          alert_on_breach: geofenceForm.alert_on_breach,
          type: "polygon",
          polygon: drawVerticesRef.current,
        }),
      });
      cancelDraw();
    } catch {
      // Fail silently
    } finally {
      setSavingGeofence(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geofenceForm]);

  const cancelDraw = useCallback(() => {
    setDrawMode(false);
    setDrawComplete(false);
    drawVerticesRef.current = [];
    drawLayerGroupRef.current?.clearLayers();
    if (drawPolylineRef.current) {
      drawPolylineRef.current = null;
    }
    setGeofenceForm({ name: "", alert_on_breach: true });
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Asset search — pan to matching asset                             */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!assetSearch.trim() || !config || !mapRef.current) return;
    const term = assetSearch.trim().toLowerCase();
    const match = config.tracked_assets.find(
      (a) => a.name.toLowerCase().includes(term) && a.position
    );
    if (match?.position) {
      mapRef.current.panTo([match.position.lat, match.position.lng]);
    }
  }, [assetSearch, config]);

  /* ---------------------------------------------------------------- */
  /*  Core layer renderer                                              */
  /* ---------------------------------------------------------------- */

  function renderLayers(map: any, L: any, cfg: MapConfig) {
    if (layerGroupRef.current) layerGroupRef.current.clearLayers();
    const lg = layerGroupRef.current || map;

    // ── Geofences ──────────────────────────────────────────────
    if (showGeofences) {
      cfg.geofences.forEach((fence) => {
        if (!fence.active) return;
        if (fence.type === "polygon" && fence.polygon.length > 0) {
          const latlngs = fence.polygon.map(
            (p) => [p.lat, p.lng] as [number, number]
          );
          L.polygon(latlngs, {
            color: fence.color,
            fillColor: fence.color,
            fillOpacity: fence.opacity,
            weight: 2,
          })
            .addTo(lg)
            .bindPopup(
              `<b>${fence.name}</b><br/>Type: Geofence (polygon)`
            );
        } else if (fence.type === "circle" && fence.center) {
          L.circle([fence.center.lat, fence.center.lng], {
            radius: fence.radius,
            color: fence.color,
            fillColor: fence.color,
            fillOpacity: fence.opacity,
          })
            .addTo(lg)
            .bindPopup(`<b>${fence.name}</b><br/>Radius: ${fence.radius}m`);
        }
      });
    }

    // ── Cameras, Doors, Sensors ────────────────────────────────
    if (showCameras) {
      cfg.floor_plans.forEach((fp) => {
        // Cameras + FOV cones
        fp.cameras.forEach((cam) => {
          const color =
            cam.status === "online"
              ? "#22c55e"
              : cam.status === "offline"
              ? "#ef4444"
              : "#eab308";

          // FOV cone as background div icon
          const heading = cam.heading ?? 0;
          const fovSvg = fovWedgeSvg(heading, 40);
          const fovIcon = L.divIcon({
            className: "",
            html: fovSvg,
            iconSize: [88, 88],
            iconAnchor: [44, 44],
          });
          L.marker([cam.lat, cam.lng], {
            icon: fovIcon,
            interactive: false,
            zIndexOffset: -100,
          }).addTo(lg);

          // Camera circle marker
          const icon = L.divIcon({
            className: "",
            html: `<div style="width:24px;height:24px;border-radius:50%;background:${color};border:2px solid white;display:flex;align-items:center;justify-content:center;font-size:11px;color:white;box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:pointer;" title="${cam.name}">C</div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
          });
          L.marker([cam.lat, cam.lng], { icon })
            .addTo(lg)
            .bindPopup(
              `<b>${cam.name}</b><br/>Status: ${cam.status}<br/>ID: ${cam.id}`
            );
        });

        // Doors
        fp.doors.forEach((door) => {
          const doorColor =
            door.state === "closed"
              ? "#22c55e"
              : door.state === "open"
              ? "#eab308"
              : "#ef4444";
          const icon = L.divIcon({
            className: "",
            html: `<div style="width:20px;height:20px;border-radius:4px;background:${doorColor};border:2px solid white;display:flex;align-items:center;justify-content:center;font-size:10px;color:white;box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:pointer;" title="${door.name}">D</div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          });
          L.marker([door.lat, door.lng], { icon })
            .addTo(lg)
            .bindPopup(`<b>${door.name}</b><br/>State: ${door.state}`);
        });

        // Sensors
        fp.sensors.forEach((sensor) => {
          const icon = L.divIcon({
            className: "",
            html: `<div style="width:16px;height:16px;border-radius:50%;background:#8b5cf6;border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3);cursor:pointer;" title="Sensor ${sensor.id}"></div>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          });
          L.marker([sensor.lat, sensor.lng], { icon })
            .addTo(lg)
            .bindPopup(`<b>Sensor: ${sensor.id}</b><br/>Type: ${sensor.type}`);
        });
      });
    }

    // ── Tracked Assets (with search filter + clustering) ───────
    if (showAssets) {
      const statusColors: Record<string, string> = {
        active: "#22c55e",
        idle: "#eab308",
        offline: "#6b7280",
        emergency: "#ef4444",
      };
      const typeLabels: Record<string, string> = {
        patrol_officer: "P",
        vehicle: "V",
        drone: "U",
        equipment: "E",
      };

      const term = assetSearch.trim().toLowerCase();
      const filteredAssets = cfg.tracked_assets.filter((a) => {
        if (!a.position) return false;
        if (term && !a.name.toLowerCase().includes(term)) return false;
        return true;
      });

      // Cluster if zoomed out
      const clusterThreshold = 13; // zoom < 13 triggers clustering
      if (currentZoom < clusterThreshold && filteredAssets.length > 5) {
        // Simple pixel-distance clustering (~50px at zoom level)
        // We project latlng to pixel using map's project method
        const clusters: Array<{
          assets: typeof filteredAssets;
          center: { lat: number; lng: number };
        }> = [];

        filteredAssets.forEach((asset) => {
          if (!asset.position) return;
          const px = map.project(
            [asset.position.lat, asset.position.lng],
            currentZoom
          );
          let addedToCluster = false;

          for (const cluster of clusters) {
            const cpx = map.project(
              [cluster.center.lat, cluster.center.lng],
              currentZoom
            );
            const dx = px.x - cpx.x;
            const dy = px.y - cpx.y;
            if (Math.sqrt(dx * dx + dy * dy) < 50) {
              cluster.assets.push(asset);
              // Update cluster center (average)
              cluster.center.lat =
                cluster.assets.reduce(
                  (s, a) => s + (a.position?.lat ?? 0),
                  0
                ) / cluster.assets.length;
              cluster.center.lng =
                cluster.assets.reduce(
                  (s, a) => s + (a.position?.lng ?? 0),
                  0
                ) / cluster.assets.length;
              addedToCluster = true;
              break;
            }
          }

          if (!addedToCluster) {
            clusters.push({
              assets: [asset],
              center: { lat: asset.position!.lat, lng: asset.position!.lng },
            });
          }
        });

        clusters.forEach((cluster) => {
          if (cluster.assets.length === 1) {
            renderAssetMarker(L, lg, cluster.assets[0], statusColors, typeLabels);
          } else {
            const icon = L.divIcon({
              className: "",
              html: `<div style="width:38px;height:38px;border-radius:50%;background:#1e40af;border:3px solid #06b6d4;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:bold;color:#e2e8f0;box-shadow:0 2px 12px rgba(0,0,0,0.5);cursor:pointer;">${cluster.assets.length}</div>`,
              iconSize: [38, 38],
              iconAnchor: [19, 19],
            });
            const names = cluster.assets.map((a) => a.name).join("<br/>");
            L.marker([cluster.center.lat, cluster.center.lng], { icon })
              .addTo(lg)
              .bindPopup(
                `<b>${cluster.assets.length} Assets</b><br/>${names}`
              );
          }
        });
      } else {
        filteredAssets.forEach((asset) =>
          renderAssetMarker(L, lg, asset, statusColors, typeLabels)
        );
      }
    }
  }

  function renderAssetMarker(
    L: any,
    lg: any,
    asset: MapConfig["tracked_assets"][0],
    statusColors: Record<string, string>,
    typeLabels: Record<string, string>
  ) {
    if (!asset.position) return;
    const color = statusColors[asset.status] || "#6b7280";
    const label = typeLabels[asset.type] || "?";
    const isActiveTrail = activeTrailAssetId === asset.id;

    const icon = L.divIcon({
      className: "",
      html: `<div style="width:32px;height:32px;border-radius:50%;background:${color};border:3px solid ${isActiveTrail ? "#06b6d4" : "white"};display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:bold;color:white;box-shadow:0 2px 12px rgba(0,0,0,0.4);cursor:pointer;transform:rotate(${asset.heading}deg);" title="${asset.name}">${label}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });

    const batteryStr =
      asset.battery !== null ? `<br/>Battery: ${asset.battery}%` : "";

    const trailBtnId = `trail-btn-${asset.id}`;
    const popup = L.popup().setContent(
      `<div style="min-width:160px;">
        <b>${asset.name}</b><br/>
        Type: ${asset.type}<br/>
        Status: ${asset.status}<br/>
        Speed: ${asset.speed.toFixed(1)} m/s${batteryStr}
        <br/><br/>
        <button id="${trailBtnId}" style="background:#06b6d4;color:white;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;">
          ${isActiveTrail ? "Hide Trail" : "Show Trail"}
        </button>
      </div>`
    );

    const marker = L.marker([asset.position.lat, asset.position.lng], {
      icon,
    })
      .addTo(lg)
      .bindPopup(popup);

    marker.on("popupopen", () => {
      const btn = document.getElementById(trailBtnId);
      if (btn) {
        btn.addEventListener("click", () => {
          if (activeTrailAssetId === asset.id) {
            clearTrail();
          } else {
            fetchAndShowTrail(asset.id);
          }
          marker.closePopup();
        });
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Inject pulsing animation (once, via style tag)                   */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const styleId = "facility-map-styles";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      @keyframes pulseRed {
        0%   { box-shadow: 0 0 0 0 rgba(239,68,68,0.7); }
        70%  { box-shadow: 0 0 0 10px rgba(239,68,68,0); }
        100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
      }
    `;
    document.head.appendChild(style);
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Loading / Error states                                           */
  /* ---------------------------------------------------------------- */

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-slate-900 text-slate-400">
        <div className="animate-pulse text-sm">Loading map...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-slate-900 text-red-400">
        <div className="text-center">
          <p className="text-sm font-medium">{error}</p>
          <p className="text-xs text-slate-500 mt-1">
            Ensure the backend GIS service is running.
          </p>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  const totalCameras = config
    ? config.floor_plans.reduce((s, fp) => s + fp.cameras.length, 0)
    : 0;
  const totalAssets = config
    ? config.tracked_assets.filter((a) => a.position).length
    : 0;

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* ── Map container ──────────────────────────────────────── */}
      <div ref={mapContainerRef} className="h-full w-full z-0" />

      {/* ── Asset search bar ───────────────────────────────────── */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000]">
        <input
          type="text"
          placeholder="Search assets by name…"
          value={assetSearch}
          onChange={(e) => setAssetSearch(e.target.value)}
          className="w-56 bg-slate-800/90 backdrop-blur-sm border border-slate-600 text-slate-200 placeholder-slate-500 text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
        />
      </div>

      {/* ── Right toolbar ──────────────────────────────────────── */}
      <div className="absolute top-4 right-4 z-[1000] flex flex-col gap-2">

        {/* Layer toggles panel */}
        <div className="bg-slate-800/90 backdrop-blur-sm rounded-lg p-3 space-y-2 text-sm border border-slate-700">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
            Layers
          </div>
          {[
            {
              label: "Geofences",
              value: showGeofences,
              setter: setShowGeofences,
              color: "bg-red-500",
            },
            {
              label: "Cameras & Sensors",
              value: showCameras,
              setter: setShowCameras,
              color: "bg-green-500",
            },
            {
              label: "Tracked Assets",
              value: showAssets,
              setter: setShowAssets,
              color: "bg-blue-500",
            },
            {
              label: heatmapLoading ? "Heatmap (loading…)" : "Heatmap",
              value: showHeatmap,
              setter: setShowHeatmap,
              color: "bg-orange-500",
            },
            {
              label: "Violations",
              value: showViolations,
              setter: setShowViolations,
              color: "bg-pink-500",
            },
          ].map(({ label, value, setter, color }) => (
            <label
              key={label}
              className="flex items-center gap-2 cursor-pointer text-slate-300 hover:text-white"
            >
              <div
                onClick={() => setter(!value)}
                className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
                  value ? `${color} border-transparent` : "border-slate-500"
                }`}
              >
                {value && (
                  <span className="text-white text-[10px]">&#10003;</span>
                )}
              </div>
              <span className="text-xs">{label}</span>
            </label>
          ))}
        </div>

        {/* Tool buttons */}
        <div className="bg-slate-800/90 backdrop-blur-sm rounded-lg p-2 flex flex-col gap-1.5 border border-slate-700">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider px-1 mb-1">
            Tools
          </div>

          {/* Draw geofence */}
          <button
            onClick={() => {
              if (drawMode) {
                cancelDraw();
              } else {
                setMeasureMode(false);
                setDrawMode(true);
                setDrawComplete(false);
              }
            }}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              drawMode
                ? "bg-cyan-600 text-white"
                : "bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white"
            }`}
          >
            <span>&#9650;</span>
            {drawMode ? "Drawing…" : "Draw Geofence"}
          </button>

          {/* Measure */}
          <button
            onClick={() => {
              if (measureMode) {
                setMeasureMode(false);
              } else {
                setDrawMode(false);
                cancelDraw();
                setMeasureMode(true);
              }
            }}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              measureMode
                ? "bg-amber-600 text-white"
                : "bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white"
            }`}
          >
            <span>&#8596;</span>
            {measureMode ? "Measuring…" : "Measure"}
          </button>

          {/* My Location */}
          <button
            onClick={() => {
              if (trackingLocation) {
                if (userLocation) {
                  panToMyLocation();
                } else {
                  stopLocationTracking();
                }
              } else {
                startLocationTracking();
              }
            }}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              trackingLocation
                ? "bg-blue-600 text-white"
                : "bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white"
            }`}
            title={trackingLocation ? "Pan to my location" : "Show my location"}
          >
            <span>📍</span>
            {trackingLocation ? "My Location" : "Track Location"}
          </button>
          {trackingLocation && userLocation && (
            <div className="px-2 py-1 text-[9px] text-blue-400 font-mono">
              {userLocation.lat.toFixed(5)}, {userLocation.lng.toFixed(5)}
            </div>
          )}
          {locationError && (
            <div className="px-2 py-1 text-[9px] text-red-400">
              {locationError}
            </div>
          )}

          {/* Clear trail */}
          {activeTrailAssetId && (
            <button
              onClick={clearTrail}
              className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium bg-slate-700 text-cyan-400 hover:bg-slate-600 transition-colors"
            >
              <span>&#10007;</span> Clear Trail
            </button>
          )}
        </div>

        {/* Measure result */}
        {measureMode && measureDistance !== null && (
          <div className="bg-slate-800/90 backdrop-blur-sm rounded-lg px-3 py-2 text-xs border border-amber-600 text-amber-400">
            <div className="font-semibold mb-0.5">Distance</div>
            {measureDistance >= 1000
              ? (measureDistance / 1000).toFixed(3) + " km"
              : Math.round(measureDistance) + " m"}
          </div>
        )}
      </div>

      {/* ── Draw-mode geofence form ────────────────────────────── */}
      {drawMode && drawComplete && (
        <div className="absolute top-1/2 left-4 -translate-y-1/2 z-[1000] bg-slate-800/95 backdrop-blur-sm rounded-lg p-4 border border-cyan-700 w-64 shadow-xl">
          <div className="text-sm font-semibold text-cyan-400 mb-3">
            Save Geofence
          </div>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Name</label>
              <input
                type="text"
                value={geofenceForm.name}
                onChange={(e) =>
                  setGeofenceForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="Geofence name…"
                className="w-full bg-slate-700 border border-slate-600 text-slate-200 text-xs rounded px-2.5 py-1.5 focus:outline-none focus:border-cyan-500"
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
              <input
                type="checkbox"
                checked={geofenceForm.alert_on_breach}
                onChange={(e) =>
                  setGeofenceForm((f) => ({
                    ...f,
                    alert_on_breach: e.target.checked,
                  }))
                }
                className="accent-cyan-500"
              />
              Alert on breach
            </label>
            <div className="flex gap-2 pt-1">
              <button
                onClick={saveGeofence}
                disabled={savingGeofence}
                className="flex-1 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-medium rounded py-1.5 transition-colors"
              >
                {savingGeofence ? "Saving…" : "Save"}
              </button>
              <button
                onClick={cancelDraw}
                className="flex-1 bg-slate-600 hover:bg-slate-500 text-slate-200 text-xs font-medium rounded py-1.5 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Draw-mode in-progress cancel */}
      {drawMode && !drawComplete && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[1000] bg-slate-800/90 backdrop-blur-sm rounded-lg px-4 py-2 border border-cyan-700 text-xs text-cyan-400 flex items-center gap-3">
          <span>Click to add vertices · Double-click to finish</span>
          <button
            onClick={cancelDraw}
            className="text-slate-400 hover:text-white underline"
          >
            Cancel
          </button>
        </div>
      )}

      {/* ── Status bar ────────────────────────────────────────── */}
      {config && (
        <div className="absolute bottom-4 left-4 z-[1000] bg-slate-800/90 backdrop-blur-sm rounded-lg px-3 py-2 text-xs text-slate-400 border border-slate-700 flex gap-4 flex-wrap max-w-xs">
          <span>{config.geofences.length} Geofences</span>
          <span>{totalAssets} Assets</span>
          <span>{totalCameras} Cameras</span>
          {violations.length > 0 && (
            <span className="text-red-400">{violations.length} Alerts</span>
          )}
          {activeTrailAssetId && (
            <span className="text-cyan-400">Trail active</span>
          )}
        </div>
      )}

      {/* ── Legend ───────────────────────────────────────────── */}
      <div className="absolute bottom-4 right-4 z-[1000] bg-slate-800/90 backdrop-blur-sm rounded-lg px-3 py-2 text-xs border border-slate-700">
        <div className="text-slate-400 font-semibold mb-1.5">Legend</div>
        <div className="space-y-1 text-slate-500">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" />
            Online / Active
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-yellow-500" />
            Idle / Open
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" />
            Offline / Emergency
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-500" />
            Inactive
          </div>
          <div className="border-t border-slate-700 mt-1.5 pt-1.5 space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse" />
              Camera FOV
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-10 h-0.5 bg-gradient-to-r from-gray-500 to-cyan-400" />
              Asset Trail
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
              Violation
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
