/**
 * XContest Paragliding XC Simulator & Optimizer
 * Core Application Logic
 */

// Global state
const state = {
    mode: 'waypoint', // 'waypoint', 'freehand', or 'compare'
    waypoints: [],    // User clicked waypoints: [{lat, lng}, ...]
    freehandTrack: [], // Raw mouse track points: [{lat, lng}, ...]
    history: [],      // History stack for undo: [{waypoints, freehandTrack}]
    historyIndex: -1, // Current index in history stack
    activeSavedId: null, // ID of currently loaded saved route/track
    currentStats: null,  // Cached calculation stats for saving
    compareTracks: [],   // Array of tracks in pace comparison: [{ id, name, points, color, visible }]
    compareUtcOffset: 'auto', // Timezone offset for comparison: 'auto' or integer hours
    activeLayers: {
        satellite: null,
        topo: null,
        street: null
    },
    map: null,
    // Layer groups for drawings
    drawings: {
        trackLine: null,      // The active drawn track line
        optLine: null,        // Optimized line overlay
        markers: [],          // Markers for waypoints/Tps
        wedges: null,         // FAI wedges polygon
        closingCircle: null,  // Closing circle overlay
        compareTracksGroup: null, // Leaflet layer group for comparison tracks
        compareNodesGroup: null,  // Leaflet layer group for pace nodes
        compareLinesGroup: null   // Leaflet layer group for pacing sync-lines
    }
};

// Map Layer configurations
const LAYER_URLS = {
    satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    topo: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    street: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
};

const LAYER_ATTRIBUTIONS = {
    satellite: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    topo: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)',
    street: '&copy; OpenStreetMap contributors'
};

// Initialize Application once DOM loads
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    initUI();
    saveState(); // Save initial empty state
    showToast('Welcome to XC-Contest Simulator! Click two points to see FAI Wedges.', 'info');
});

// ==========================================
// 1. MAP INITIALIZATION & CONTROLS
// ==========================================
function initMap() {
    // Lake Berryessa, CA default coordinates
    const defaultCenter = [38.58, -122.23]; 
    
    state.map = L.map('map', {
        center: defaultCenter,
        zoom: 12,
        zoomControl: true,
        attributionControl: true
    });

    // Create the map layers
    state.activeLayers.satellite = L.tileLayer(LAYER_URLS.satellite, {
        attribution: LAYER_ATTRIBUTIONS.satellite,
        maxZoom: 19
    });
    
    state.activeLayers.topo = L.tileLayer(LAYER_URLS.topo, {
        attribution: LAYER_ATTRIBUTIONS.topo,
        maxZoom: 17
    });
    
    state.activeLayers.street = L.tileLayer(LAYER_URLS.street, {
        attribution: LAYER_ATTRIBUTIONS.street,
        maxZoom: 19
    });

    // Set default layer to satellite
    state.activeLayers.satellite.addTo(state.map);

    // Initialize drawings layer groups
    state.drawings.trackLine = L.polyline([], { color: '#00f2fe', weight: 4, opacity: 0.95 }).addTo(state.map);
    state.drawings.optLine = L.polyline([], { color: '#10b981', weight: 5, opacity: 0.9, dashArray: '1' }).addTo(state.map);
    state.drawings.wedges = L.featureGroup().addTo(state.map);
    state.drawings.closingCircle = L.featureGroup().addTo(state.map);
    state.drawings.compareTracksGroup = L.featureGroup().addTo(state.map);
    state.drawings.compareNodesGroup = L.featureGroup().addTo(state.map);
    state.drawings.compareLinesGroup = L.featureGroup().addTo(state.map);
    
    // Wire drawing interactions
    setupDrawingInteractions();
}

function switchBaseLayer(layerKey) {
    // Remove all base layers
    Object.values(state.activeLayers).forEach(layer => {
        if (layer) state.map.removeLayer(layer);
    });
    
    // Add selected layer
    if (state.activeLayers[layerKey]) {
        state.activeLayers[layerKey].addTo(state.map);
    }
}

// ==========================================
// 2. DRAWING INTERACTIONS & EVENT HANDLERS
// ==========================================
let isDrawingFreehand = false;

function setupDrawingInteractions() {
    // Click on map to place waypoints (Waypoint Mode)
    state.map.on('click', (e) => {
        if (state.mode !== 'waypoint') return;
        addWaypoint(e.latlng);
    });

    // Mousemove for previewing legs/closing circles/wedges
    state.map.on('mousemove', (e) => {
        if (state.mode === 'freehand' && isDrawingFreehand) {
            addFreehandPoint(e.latlng);
        }
    });

    // Mouse events for freehand drawing
    const mapContainer = document.getElementById('map');
    
    mapContainer.addEventListener('mousedown', (e) => {
        if (state.mode !== 'freehand') return;
        // Check if user clicked on map, not map controls
        if (e.target.closest('.leaflet-control-container')) return;
        
        // If a track is loaded, allow panning unless Shift is pressed
        if (state.freehandTrack && state.freehandTrack.length > 0 && !e.shiftKey) {
            return;
        }
        
        isDrawingFreehand = true;
        state.activeSavedId = null;
        highlightActiveSavedItem();
        state.freehandTrack = [];
        state.currentDrawingDistance = 0; // Initialize real-time distance
        state.map.dragging.disable(); // Prevent map panning while drawing
        
        // Clear previous drawing
        clearDrawings();
    });

    // Mouseup triggers optimization
    window.addEventListener('mouseup', () => {
        if (state.mode !== 'freehand' || !isDrawingFreehand) return;
        isDrawingFreehand = false;
        state.map.dragging.enable();
        
        if (state.freehandTrack.length < 5) {
            showToast('Draw a longer path to run XContest optimization!', 'info');
            clearDrawings();
            return;
        }
        
        processFreehandTrack();
    });
}

// ==========================================
// 3. WAYPOINT MODE OPERATIONS
// ==========================================
function addWaypoint(latlng) {
    state.activeSavedId = null;
    highlightActiveSavedItem();
    state.waypoints.push({ lat: latlng.lat, lng: latlng.lng });
    saveState();
    renderWaypointMode();
}

function renderWaypointMode() {
    clearMapLayers();
    
    const wps = state.waypoints;
    const len = wps.length;
    
    if (len === 0) {
        updateScoreDashboard(0, 0, 'free', [], 0, 0);
        return;
    }
 
    // 1. Draw raw clicked track as a line connecting user's clicks
    state.drawings.trackLine.setLatLngs(wps);
    state.drawings.trackLine.setStyle({ color: '#00f2fe', weight: 3, opacity: 0.7, dashArray: '' });
    
    // 2. Draw draggable div markers for every raw click point to show where they clicked
    wps.forEach((wp, idx) => {
        const marker = L.marker([wp.lat, wp.lng], {
            draggable: true,
            icon: L.divIcon({
                className: 'waypoint-drag-marker',
                html: '<div class="waypoint-marker-dot"></div>',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            })
        }).addTo(state.map);
        
        marker.isWaypointMarker = true; // Mark as raw draggable waypoint marker
        
        marker.on('drag', (e) => {
            const newLatLng = e.target.getLatLng();
            state.waypoints[idx] = { lat: newLatLng.lat, lng: newLatLng.lng };
            updateWaypointOverlaysOnly();
        });
        
        marker.on('dragend', () => {
            state.activeSavedId = null;
            highlightActiveSavedItem();
            saveState();
        });
        
        state.drawings.markers.push(marker);
    });

    // 3. Draw overlays and calculate stats
    updateWaypointOverlaysOnly();
}

// Render optimized line path, markers and wedges on top of track
function renderOptimizedOverlays(result, rawPoints) {
    const optIndices = result.indices;
    const optPoints = result.refinedPoints || optIndices.map(idx => rawPoints[idx]);
    
    if (optPoints.length < 2) return;
    
    // Draw optimized leg route
    state.drawings.optLine.setLatLngs(optPoints);
    let color = '#3b82f6';
    if (result.type === 'free_tri') color = '#a855f7';
    if (result.type === 'fai') color = '#00f2fe';
    if (result.type === 'closed_free') color = '#f59e0b';
    if (result.type === 'closed_fai') color = '#10b981';
    state.drawings.optLine.setStyle({ color: color, weight: 5, opacity: 0.95 });
    
    // Draw optimized marker pins
    const labels = ['START', 'TURNPOINT 1', 'TURNPOINT 2', 'TURNPOINT 3', 'FINISH'];
    optPoints.forEach((pt, i) => {
        let pinColor = 'marker-tp';
        if (i === 0) pinColor = 'marker-start';
        if (i === optPoints.length - 1) pinColor = 'marker-finish';
        
        const labelText = optPoints.length === 2 && i === 1 ? 'FINISH' : (labels[i] || `TP ${i}`);
        const customIcon = L.divIcon({
            className: 'custom-wp-marker',
            html: `<div class="marker-pin ${pinColor}"><span>${i + 1}</span></div><div class="marker-label">${labelText}</div>`,
            iconSize: [30, 42],
            iconAnchor: [15, 42]
        });
        
        const marker = L.marker([pt.lat, pt.lng], { icon: customIcon, interactive: false }).addTo(state.map);
        state.drawings.markers.push(marker);
    });

    // Draw FAI Wedges based on the three legs to show how the track relates to all FAI sectors (only in freehand mode)
    if (state.mode !== 'waypoint') {
        if (result.type !== 'free' && optPoints.length >= 5) {
            drawFAIWedges(optPoints[1], optPoints[2], optPoints[3]);
            drawFAIWedges(optPoints[2], optPoints[3], optPoints[1]);
            drawFAIWedges(optPoints[3], optPoints[1], optPoints[2]);
            
            // Draw closing circles around optimized start point
            const P = result.legLengths[0] + result.legLengths[1] + result.legLengths[2];
            drawClosingCircles(optPoints[0], P);
        } else if (result.type !== 'free' && optPoints.length >= 4) {
            drawFAIWedges(optPoints[1], optPoints[2]);
        }
    }

    // Update stats dashboard
    updateScoreDashboard(result.score, result.distance, result.type, result.legLengths, result.gap, result.gapPercent);
}

// Calculate and render stats dynamically in Waypoint Mode
function calculateAndDisplayWPScore(wps, isClosed) {
    const len = wps.length;
    
    // Minimum 3 points to evaluate triangle properties
    if (len === 3) {
        const p1 = wps[0];
        const p2 = wps[1];
        const p3 = wps[2];
        
        const d12 = vincentyDistance(p1, p2);
        const d23 = vincentyDistance(p2, p3);
        const d31 = vincentyDistance(p3, p1);
        const perimeter = d12 + d23 + d31;
        
        // If not closed, the "gap" is between 3rd point and start
        const gap = d31;
        const gapPercent = (gap / perimeter) * 100;
        
        let type = 'free';
        let coeff = 1.0;
        let scoredDist = d12 + d23; // Just 2 legs scored as free flight
        
        // If gap <= 20% of perimeter, it qualifies as triangle
        if (gapPercent <= 20.0) {
            const shortestLeg = Math.min(d12, d23, d31);
            const isFai = shortestLeg >= 0.28 * perimeter;
            const isClosedGap = gapPercent < 5.0;
            
            if (isFai && isClosedGap) {
                coeff = 1.60;
                type = 'closed_fai';
            } else if (isFai && !isClosedGap) {
                coeff = 1.40;
                type = 'fai';
            } else if (!isFai && isClosedGap) {
                coeff = 1.40;
                type = 'closed_free';
            } else {
                coeff = 1.20;
                type = 'free_tri';
            }
            
            scoredDist = perimeter - gap;
        }
        
        updateScoreDashboard(scoredDist * coeff, scoredDist, type, [d12, d23, d31], gap, gapPercent);
    }
    else if (len >= 4) {
        // 4 points or 5 points.
        // Start: wps[0], TP1: wps[1], TP2: wps[2], TP3: wps[3], Finish: wps[4] (or wps[3] if len=4)
        const start = wps[0];
        const tp1 = wps[1];
        const tp2 = wps[2];
        const tp3 = wps[3];
        const finish = len === 5 ? wps[4] : wps[3];
        
        const d_start_tp1 = vincentyDistance(start, tp1);
        const d_tp1_tp2 = vincentyDistance(tp1, tp2);
        const d_tp2_tp3 = vincentyDistance(tp2, tp3);
        const d_tp3_finish = len === 5 ? vincentyDistance(tp3, finish) : 0;
        
        // Check if we can form a triangle using TP1, TP2, TP3
        const triPerimeter = d_tp1_tp2 + d_tp2_tp3 + vincentyDistance(tp3, tp1);
        const gap = vincentyDistance(start, finish);
        const gapPercent = (gap / triPerimeter) * 100;
        
        let type = 'free';
        let coeff = 1.0;
        let scoredDist = d_start_tp1 + d_tp1_tp2 + d_tp2_tp3 + d_tp3_finish;
        
        if (gapPercent <= 20.0 && len >= 4) {
            const shortestLeg = Math.min(d_tp1_tp2, d_tp2_tp3, vincentyDistance(tp3, tp1));
            const isFai = shortestLeg >= 0.28 * triPerimeter;
            const isClosedGap = gapPercent < 5.0;
            
            if (isFai && isClosedGap) {
                coeff = 1.60;
                type = 'closed_fai';
            } else if (isFai && !isClosedGap) {
                coeff = 1.40;
                type = 'fai';
            } else if (!isFai && isClosedGap) {
                coeff = 1.40;
                type = 'closed_free';
            } else {
                coeff = 1.20;
                type = 'free_tri';
            }
            
            scoredDist = triPerimeter - gap;
        }
        
        const legs = [d_tp1_tp2, d_tp2_tp3, vincentyDistance(tp3, tp1)];
        updateScoreDashboard(scoredDist * coeff, scoredDist, type, legs, gap, gapPercent);
    }
}

// ==========================================
// 4. FREEHAND MODE OPERATIONS (OPTIMIZATION)
// ==========================================
function addFreehandPoint(latlng) {
    const pt = { lat: latlng.lat, lng: latlng.lng };
    
    if (state.freehandTrack.length > 0) {
        const lastPt = state.freehandTrack[state.freehandTrack.length - 1];
        const d = vincentyDistance(lastPt, pt);
        state.currentDrawingDistance = (state.currentDrawingDistance || 0) + d;
        
        // Update dashboard in real-time
        updateScoreDashboard(state.currentDrawingDistance, state.currentDrawingDistance, 'free', [], 0, 0);
    } else {
        state.currentDrawingDistance = 0;
    }
    
    state.freehandTrack.push(pt);
    
    // Draw the active line trace in real-time
    state.drawings.trackLine.addLatLng(latlng);
}

function processFreehandTrack() {
    showToast('Analyzing track & running XContest optimizer...', 'info');
    
    // 1. Simplify track log using RDP to speed up combinatorial optimization
    const rawPoints = state.freehandTrack;
    
    const bannerEl = document.getElementById('active-track-name');
    if (!bannerEl || !bannerEl.textContent || bannerEl.textContent === 'No track loaded' || bannerEl.textContent === '') {
        updateActiveTrackDisplay('Freehand Sketch');
    }
    
    // Binary search for epsilon to get between 70 and 80 points if possible,
    // avoiding aggressive downsampling which gets refinement stuck in local minima.
    let lo = 0.0001;
    let hi = 10.0;
    let simplified = [];
    for (let iter = 0; iter < 12; iter++) {
        let mid = (lo + hi) / 2;
        let testSimp = rdpSimplify(rawPoints, mid);
        if (testSimp.length > 80) {
            lo = mid;
        } else {
            hi = mid;
            simplified = testSimp;
        }
    }
    if (simplified.length < 5) {
        simplified = rdpSimplify(rawPoints, lo);
        if (simplified.length > 80) {
            const factor = Math.ceil(simplified.length / 80);
            simplified = simplified.filter((_, idx) => idx % factor === 0);
        }
    }
    
    // Run XContest scoring optimization on simplified track
    const optResultCoarse = optimizeTrack(simplified);
    
    if (!optResultCoarse || optResultCoarse.score === 0) {
        showToast('Could not optimize track. Try drawing a larger loop!', 'info');
        clearDrawings();
        return;
    }
    
    // Map simplified points to raw indices
    const mappingToRaw = [];
    for (let pt of simplified) {
        let minDist = Infinity;
        let bestIdx = 0;
        for (let i = 0; i < rawPoints.length; i++) {
            const rpt = rawPoints[i];
            const d = Math.abs(rpt.lat - pt.lat) + Math.abs(rpt.lng - pt.lng);
            if (d < minDist) {
                minDist = d;
                bestIdx = i;
            }
        }
        mappingToRaw.push(bestIdx);
    }
    
    // Run Hierarchical Refinement on rawPoints
    const optResultRefined = refineOptimizedFlight(rawPoints, optResultCoarse, mappingToRaw);
    
    // Save state for undo/redo
    saveState();
    
    // Render optimized result
    renderOptimizationResult(optResultRefined, rawPoints, simplified);
}

function renderOptimizationResult(result, rawPoints, simplified) {
    clearMapLayers();
    
    // Draw raw track log in faded cyan
    state.drawings.trackLine.setLatLngs(rawPoints);
    state.drawings.trackLine.setStyle({ color: '#00f2fe', weight: 2.5, opacity: 0.35 });
    
    // Draw simplified track in dotted blue
    state.drawings.simplifiedLine = L.polyline(simplified, {
        color: '#3b82f6',
        weight: 1.5,
        opacity: 0.5,
        dashArray: '3, 5'
    }).addTo(state.map);
    
    // Extract optimized indices points
    const optIndices = result.indices;
    const optPoints = result.refinedPoints || optIndices.map(idx => simplified[idx]);
    
    // Draw optimized leg route
    state.drawings.optLine.setLatLngs(optPoints);
    let color = '#3b82f6';
    if (result.type === 'free_tri') color = '#a855f7';
    if (result.type === 'fai') color = '#00f2fe';
    if (result.type === 'closed_free') color = '#f59e0b';
    if (result.type === 'closed_fai') color = '#10b981';
    state.drawings.optLine.setStyle({ color: color, weight: 5, opacity: 0.95 });
    
    // Draw optimized markers
    const labels = ['START', 'TURNPOINT 1', 'TURNPOINT 2', 'TURNPOINT 3', 'FINISH'];
    optPoints.forEach((pt, i) => {
        let pinColor = 'marker-tp';
        if (i === 0) pinColor = 'marker-start';
        if (i === optPoints.length - 1) pinColor = 'marker-finish';
        
        const customIcon = L.divIcon({
            className: 'custom-wp-marker',
            html: `<div class="marker-pin ${pinColor}"><span>${i + 1}</span></div><div class="marker-label">${labels[i]}</div>`,
            iconSize: [30, 42],
            iconAnchor: [15, 42]
        });
        
        const marker = L.marker([pt.lat, pt.lng], { icon: customIcon, interactive: false }).addTo(state.map);
        state.drawings.markers.push(marker);
    });

    // Draw FAI Wedges based on optimized legs to show how the track relates to FAI sectors
    if (result.type !== 'free' && optPoints.length >= 5) {
        drawFAIWedges(optPoints[1], optPoints[2], optPoints[3]);
        drawFAIWedges(optPoints[2], optPoints[3], optPoints[1]);
        drawFAIWedges(optPoints[3], optPoints[1], optPoints[2]);
        
        // Draw closing circles around optimized start point
        const P = result.legLengths[0] + result.legLengths[1] + result.legLengths[2];
        drawClosingCircles(optPoints[0], P);
    } else if (result.type !== 'free' && optPoints.length >= 4) {
        drawFAIWedges(optPoints[1], optPoints[2]);
    }

    // Display optimized scores in sidebar
    updateScoreDashboard(result.score, result.distance, result.type, result.legLengths, result.gap, result.gapPercent);
    
    let toastType = (result.type === 'fai' || result.type === 'closed_fai') ? 'success' : 'info';
    showToast(`Optimized: ${result.type.replace('_', ' ').toUpperCase()} flight! Score: ${result.score.toFixed(2)} pts`, toastType);
}

// ==========================================
// 5. CORE GEOMETRIC MATH & FAI WEDGES
// ==========================================

// Haversine formula to compute geodesic distance in km
function haversineDistance(p1, p2) {
    const R = 6371; // km
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLon = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Compass bearing between two points in radians
function bearing(p1, p2) {
    const lat1 = p1.lat * Math.PI / 180;
    const lat2 = p2.lat * Math.PI / 180;
    const dLon = (p2.lng - p1.lng) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
              Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return Math.atan2(y, x);
}

// Compute destination point from start, distance (km), and bearing (radians)
function destinationPoint(start, distKm, brngRad) {
    const R = 6371; // km
    const dR = distKm / R;
    const lat1 = start.lat * Math.PI / 180;
    const lon1 = start.lng * Math.PI / 180;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dR) +
                           Math.cos(lat1) * Math.sin(dR) * Math.cos(brngRad));
    const lon2 = lon1 + Math.atan2(Math.sin(brngRad) * Math.sin(dR) * Math.cos(lat1),
                                   Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2));
    return {
        lat: lat2 * 180 / Math.PI,
        lng: ((lon2 * 180 / Math.PI + 180) % 360 + 360) % 360 - 180
    };
}

// Numerical solver for left boundary curve: 18 * b - 7 * a = 7 * c
function solveYForLeftCurve(x, c) {
    let yMin = 0;
    let yMax = 2.5 * c;
    for (let iter = 0; iter < 18; iter++) {
        let y = (yMin + yMax) / 2;
        let b = Math.sqrt(x*x + y*y);
        let a = Math.sqrt((x-c)*(x-c) + y*y);
        let val = 18 * b - 7 * a;
        if (val < 7 * c) {
            yMin = y;
        } else {
            yMax = y;
        }
    }
    return (yMin + yMax) / 2;
}

// Numerical solver for right boundary curve: 18 * a - 7 * b = 7 * c
function solveYForRightCurve(x, c) {
    let yMin = 0;
    let yMax = 2.5 * c;
    for (let iter = 0; iter < 18; iter++) {
        let y = (yMin + yMax) / 2;
        let b = Math.sqrt(x*x + y*y);
        let a = Math.sqrt((x-c)*(x-c) + y*y);
        let val = 18 * a - 7 * b;
        if (val < 7 * c) {
            yMin = y;
        } else {
            yMax = y;
        }
    }
    return (yMin + yMax) / 2;
}

// Generate local (x, y) coordinates for FAI Wedge in upper half-plane
function generateWedgeLocalPoints(c) {
    const points = [];
    
    // 1. Left curve: from bottom midpoint (0.5 * c) to left corner (-23/98 * c)
    const leftSteps = 12;
    const xStartLeft = 0.5 * c;
    const xEndLeft = -23 / 98 * c;
    for (let i = 0; i <= leftSteps; i++) {
        let t = i / leftSteps;
        let x = xStartLeft * (1 - t) + xEndLeft * t;
        let y = solveYForLeftCurve(x, c);
        points.push({ x, y });
    }
    
    // 2. Ellipse Arc: theta from theta1 (2.182 rad) down to theta2 (0.959 rad)
    const ellipseSteps = 16;
    const theta1 = Math.PI - Math.acos(4/7);
    const theta2 = Math.acos(4/7);
    const ae = (9/7) * c;
    const be = (Math.sqrt(275)/14) * c;
    for (let i = 1; i < ellipseSteps; i++) {
        let t = i / ellipseSteps;
        let theta = theta1 * (1 - t) + theta2 * t;
        let x = c/2 + ae * Math.cos(theta);
        let y = be * Math.sin(theta);
        points.push({ x, y });
    }
    
    // 3. Right curve: from right corner (121/98 * c) back to bottom midpoint (0.5 * c)
    const rightSteps = 12;
    const xStartRight = 121 / 98 * c;
    const xEndRight = 0.5 * c;
    for (let i = 0; i <= rightSteps; i++) {
        let t = i / rightSteps;
        let x = xStartRight * (1 - t) + xEndRight * t;
        let y = solveYForRightCurve(x, c);
        points.push({ x, y });
    }
    
    return points;
}

// Draw FAI Wedges on map based on leg A -> B. If C is provided, only draw the wedge on the side of C.
function drawFAIWedges(A, B, C = null) {
    const c = vincentyDistance(A, B);
    const alpha = bearing(A, B); // Angle of line AB
    
    let drawUpper = true;
    let drawLower = true;
    
    if (C) {
        const alpha_AC = bearing(A, C);
        let diff = alpha_AC - alpha;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        if (diff > 0) {
            drawLower = false;
        } else {
            drawUpper = false;
        }
    }
    
    // Generate local wedge points (upper half plane)
    const localPoints = generateWedgeLocalPoints(c);
    
    // Render as Leaflet Polygons
    const fillOpt = {
        color: '#d946ef',
        fillColor: '#d946ef',
        fillOpacity: 0.16,
        weight: 1.5,
        dashArray: '3, 4'
    };
    
    if (drawUpper) {
        // Project local points to global coordinates
        const upperWedgeCoords = localPoints.map(pt => {
            const d = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
            const phi = Math.atan2(pt.y, pt.x); // Local angle
            const gp = destinationPoint(A, d, alpha + phi); // Project globally
            return [gp.lat, gp.lng];
        });
        const upperPolygon = L.polygon(upperWedgeCoords, fillOpt);
        upperPolygon.addTo(state.drawings.wedges);
    }

    if (drawLower) {
        const lowerWedgeCoords = localPoints.map(pt => {
            // For lower wedge, we reflect y to -y
            const d = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
            const phi = Math.atan2(-pt.y, pt.x); // Local angle reflected
            const gp = destinationPoint(A, d, alpha + phi); // Project globally
            return [gp.lat, gp.lng];
        });
        const lowerPolygon = L.polygon(lowerWedgeCoords, fillOpt);
        lowerPolygon.addTo(state.drawings.wedges);
    }
}

function drawClosingCircles(startPt, perimeter) {
    if (!state.drawings.closingCircle) return;
    state.drawings.closingCircle.clearLayers();
    
    // 20% limit circle (orange/amber)
    const radius20 = (perimeter * 0.20) * 1000; // in meters
    const circle20 = L.circle([startPt.lat, startPt.lng], {
        radius: radius20,
        color: 'rgba(245, 158, 11, 0.45)',
        fillColor: 'rgba(245, 158, 11, 0.02)',
        weight: 1.5,
        dashArray: '4, 5',
        interactive: false
    });
    circle20.addTo(state.drawings.closingCircle);
    
    // 5% limit circle (emerald/green)
    const radius5 = (perimeter * 0.05) * 1000; // in meters
    const circle5 = L.circle([startPt.lat, startPt.lng], {
        radius: radius5,
        color: 'rgba(16, 185, 129, 0.45)',
        fillColor: 'rgba(16, 185, 129, 0.02)',
        weight: 1.5,
        dashArray: '2, 3',
        interactive: false
    });
    circle5.addTo(state.drawings.closingCircle);
}

// ==========================================
// 6. XCONTEST OPTIMIZATION ALGORITHM
// ==========================================
function optimizeTrack(points) {
    const N = points.length;
    if (N < 2) return null;
    
    // Precompute all pairwise distances
    const dist = Array(N).fill(0).map(() => Array(N).fill(0));
    for (let i = 0; i < N; i++) {
        for (let j = i; j < N; j++) {
            const d = vincentyDistance(points[i], points[j]);
            dist[i][j] = d;
            dist[j][i] = d;
        }
    }
    
    let bestScore = 0;
    let bestType = 'free';
    let bestIndices = [];
    let bestLegLengths = [];
    let bestGap = 0;
    let bestGapPercent = 0;
    let bestScoredDist = 0;
    let bestFreeDist = 0;

    // --- OPTION 1: FREE FLIGHT (up to 3 turnpoints, i.e., up to 4 segments) ---
    // DP to maximize distance: dp[k][i] is max distance using k segments ending at index i
    const dp = Array(5).fill(0).map(() => Array(N).fill(0));
    const parent = Array(5).fill(0).map(() => Array(N).fill(-1));
    
    // Segment 1
    for (let i = 0; i < N; i++) {
        for (let j = 0; j < i; j++) {
            if (dist[j][i] > dp[1][i]) {
                dp[1][i] = dist[j][i];
                parent[1][i] = j;
            }
        }
    }
    
    // Segments 2, 3, 4
    for (let k = 2; k <= 4; k++) {
        for (let i = 0; i < N; i++) {
            for (let j = 0; j < i; j++) {
                if (dp[k-1][j] + dist[j][i] > dp[k][i]) {
                    dp[k][i] = dp[k-1][j] + dist[j][i];
                    parent[k][i] = j;
                }
            }
        }
    }
    
    // Find best free path
    let bestFreeEnd = -1;
    let bestFreeK = 1;
    for (let k = 1; k <= 4; k++) {
        for (let i = 0; i < N; i++) {
            if (dp[k][i] > bestFreeDist) {
                bestFreeDist = dp[k][i];
                bestFreeEnd = i;
                bestFreeK = k;
            }
        }
    }
    
    if (bestFreeEnd !== -1) {
        let curr = bestFreeEnd;
        let k = bestFreeK;
        const indices = [];
        while (curr !== -1) {
            indices.unshift(curr);
            curr = parent[k][curr];
            k--;
        }
        
        bestScore = bestFreeDist * 1.0;
        bestType = 'free';
        bestIndices = indices;
        bestLegLengths = indices.slice(1).map((idx, i) => dist[indices[i]][idx]);
    }

    // --- OPTION 2: TRIANGLES (Flat / FAI) ---
    // A triangle has 3 turnpoints (i1, i2, i3) plus start (is) and finish (if)
    // Constraint: is <= i1 < i2 < i3 <= if
    // Precompute minimum gap dist[is][if] for any (i1, i3) pair
    // dp[i1][hf] stores min(dist[is][hf]) for 0 <= is <= i1
    const dpGap = Array(N).fill(null).map(() => Array(N).fill(Infinity));
    // parent_is[i1][hf] stores the 'is' index that achieved this minimum
    const parent_is = Array(N).fill(null).map(() => Array(N).fill(-1));

    for (let hf = 0; hf < N; hf++) {
        dpGap[0][hf] = dist[0][hf];
        parent_is[0][hf] = 0;
        for (let i1 = 1; i1 < N; i1++) {
            if (dist[i1][hf] < dpGap[i1 - 1][hf]) {
                dpGap[i1][hf] = dist[i1][hf];
                parent_is[i1][hf] = i1;
            } else {
                dpGap[i1][hf] = dpGap[i1 - 1][hf];
                parent_is[i1][hf] = parent_is[i1 - 1][hf];
            }
        }
    }

    const minGap = Array(N).fill(null).map(() => Array(N).fill(null));
    for (let i1 = 0; i1 < N; i1++) {
        // Base case hf = N - 1
        let minG = dpGap[i1][N - 1];
        let bestIs = parent_is[i1][N - 1];
        let bestIf = N - 1;
        minGap[i1][N - 1] = { val: minG, is: bestIs, if: bestIf };

        for (let i3 = N - 2; i3 > i1; i3--) {
            if (dpGap[i1][i3] < minG) {
                minG = dpGap[i1][i3];
                bestIs = parent_is[i1][i3];
                bestIf = i3;
            }
            minGap[i1][i3] = { val: minG, is: bestIs, if: bestIf };
        }
    }
    
    // Brute force all i1 < i2 < i3 combinations (fast via precalculated gaps)
    for (let i1 = 0; i1 < N; i1++) {
        for (let i2 = i1 + 1; i2 < N; i2++) {
            for (let i3 = i2 + 1; i3 < N; i3++) {
                const P = dist[i1][i2] + dist[i2][i3] + dist[i3][i1];
                const gapData = minGap[i1][i3];
                if (!gapData) continue;
                const g = gapData.val;
                
                // Closing gap must be <= 20% of perimeter
                if (g <= 0.20 * P) {
                    const scoredDist = P - g;
                    const s1 = dist[i1][i2];
                    const s2 = dist[i2][i3];
                    const s3 = dist[i3][i1];
                    const shortestLeg = Math.min(s1, s2, s3);
                    
                    const isFai = shortestLeg >= 0.28 * P;
                    const isClosed = (g / P) < 0.05; // Gap < 5% of perimeter
                    
                    let coeff = 1.0;
                    let type = 'free_tri';
                    
                    if (isFai && isClosed) {
                        coeff = 1.60;
                        type = 'closed_fai';
                    } else if (isFai && !isClosed) {
                        coeff = 1.40;
                        type = 'fai';
                    } else if (!isFai && isClosed) {
                        coeff = 1.40;
                        type = 'closed_free';
                    } else {
                        coeff = 1.20;
                        type = 'free_tri';
                    }
                    
                    const score = scoredDist * coeff;
                    
                    if (score > bestScore) {
                        bestScore = score;
                        bestType = type;
                        bestIndices = [gapData.is, i1, i2, i3, gapData.if];
                        bestLegLengths = [s1, s2, s3];
                        bestGap = g;
                        bestGapPercent = (g / P) * 100;
                        bestScoredDist = scoredDist;
                    }
                }
            }
        }
    }
    
    return {
        score: bestScore,
        distance: bestType === 'free' ? bestFreeDist : bestScoredDist,
        type: bestType,
        indices: bestIndices,
        legLengths: bestLegLengths,
        gap: bestGap,
        gapPercent: bestGapPercent
    };
}

// Ramer-Douglas-Peucker (RDP) path simplification
function rdpSimplify(points, epsilon) {
    if (points.length <= 2) return points;

    // Precompute cos of average latitude once to enable fast flat distance approximation
    let sumLat = 0;
    for (let i = 0; i < points.length; i++) {
        sumLat += points[i].lat;
    }
    const avgLat = sumLat / points.length;
    const cosAvgLat = Math.cos(avgLat * Math.PI / 180);

    function distanceToSegmentFlat(p, p1, p2) {
        const x = p.lng;
        const y = p.lat;
        const x1 = p1.lng;
        const y1 = p1.lat;
        const x2 = p2.lng;
        const y2 = p2.lat;
        
        const A = x - x1;
        const B = y - y1;
        const C = x2 - x1;
        const D = y2 - y1;
        
        const dot = A * C + B * D;
        const len_sq = C * C + D * D;
        let param = -1;
        if (len_sq !== 0) param = dot / len_sq;
            
        let xx, yy;
        if (param < 0) {
            xx = x1;
            yy = y1;
        } else if (param > 1) {
            xx = x2;
            yy = y2;
        } else {
            xx = x1 + param * C;
            yy = y1 + param * D;
        }
        
        // Flat Earth distance approximation in km
        const dLat = (y - yy) * 111.12;
        const dLng = (x - xx) * 111.12 * cosAvgLat;
        return Math.sqrt(dLat * dLat + dLng * dLng);
    }

    function simplify(pts) {
        if (pts.length <= 2) return pts;
        
        let maxDist = 0;
        let index = 0;
        const end = pts.length - 1;
        
        for (let i = 1; i < end; i++) {
            const dist = distanceToSegmentFlat(pts[i], pts[0], pts[end]);
            if (dist > maxDist) {
                maxDist = dist;
                index = i;
            }
        }
        
        if (maxDist > epsilon) {
            const results1 = simplify(pts.slice(0, index + 1));
            const results2 = simplify(pts.slice(index));
            return results1.slice(0, results1.length - 1).concat(results2);
        } else {
            return [pts[0], pts[end]];
        }
    }

    return simplify(points);
}

// ==========================================
// 7. USER INTERFACE & STATE MANAGEMENT
// ==========================================
function initUI() {
    // Mode toggles
    document.getElementById('btn-mode-waypoint').addEventListener('click', () => setMode('waypoint'));
    document.getElementById('btn-mode-freehand').addEventListener('click', () => setMode('freehand'));
    document.getElementById('btn-mode-compare').addEventListener('click', () => setMode('compare'));
    
    // Time slider listener
    const timeSlider = document.getElementById('compare-time-slider');
    if (timeSlider) {
        timeSlider.addEventListener('input', (e) => {
            updateCompareTimeFilter(parseInt(e.target.value));
        });
    }

    // Timezone select listener
    const tzSelect = document.getElementById('compare-timezone');
    if (tzSelect) {
        tzSelect.addEventListener('change', (e) => {
            const val = e.target.value;
            state.compareUtcOffset = val === 'auto' ? 'auto' : parseInt(val, 10);
            updateTrackLocalTimes();
            renderCompareMode();
        });
    }

    // Map layer buttons
    document.getElementById('btn-layer-satellite').addEventListener('click', (e) => setActiveLayer(e.target, 'satellite'));
    document.getElementById('btn-layer-topo').addEventListener('click', (e) => setActiveLayer(e.target, 'topo'));
    document.getElementById('btn-layer-street').addEventListener('click', (e) => setActiveLayer(e.target, 'street'));
    
    // Actions
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);
    document.getElementById('btn-clear').addEventListener('click', clearAll);
    
    // Save Current Button Listener
    const saveBtn = document.getElementById('btn-save-current');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveCurrentFlight);
    }

    // File Upload Listener
    const fileInput = document.getElementById('input-file-upload');
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = (event) => {
                const content = event.target.result;
                const name = file.name.toLowerCase();
                let points = [];
                
                if (name.endsWith('.igc')) {
                    points = parseIGC(content);
                } else if (name.endsWith('.gpx')) {
                    points = parseGPX(content);
                } else if (name.endsWith('.kml')) {
                    points = parseKML(content);
                }
                
                if (points && points.length >= 2) {
                    loadImportedTrack(points, `Uploaded File: ${file.name}`);
                } else {
                    showToast('Failed to parse track points. Check file format!', 'danger');
                }
                fileInput.value = ''; // Reset input after operation finishes
            };
            
            reader.onerror = (err) => {
                const errName = reader.error ? reader.error.name : "UnknownError";
                const errMsg = reader.error ? reader.error.message : "No error message";
                console.error("FileReader error:", errName, "-", errMsg, err);
                fileInput.value = '';
            };
            
            reader.readAsText(file);
        });
    }

    // Initialize Saved Routes & Tracks List
    renderSavedList();

    // Mobile Sidebar Toggle and Backdrop listeners
    const sidebarToggle = document.getElementById('btn-sidebar-toggle');
    const backdrop = document.getElementById('sidebar-backdrop');
    const sidebar = document.querySelector('.sidebar');
    
    if (sidebarToggle && backdrop && sidebar) {
        const toggleSidebar = () => {
            const isOpen = sidebar.classList.toggle('open');
            sidebarToggle.classList.toggle('active', isOpen);
            backdrop.classList.toggle('active', isOpen);
        };
        
        sidebarToggle.addEventListener('click', toggleSidebar);
        backdrop.addEventListener('click', toggleSidebar);
    }
}

function closeSidebarOnMobile() {
    const sidebar = document.querySelector('.sidebar');
    const sidebarToggle = document.getElementById('btn-sidebar-toggle');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar && sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
        if (sidebarToggle) sidebarToggle.classList.remove('active');
        if (backdrop) backdrop.classList.remove('active');
    }
}

function setMode(newMode, silent = false) {
    if (state.mode === newMode) return;
    
    state.mode = newMode;
    document.getElementById('btn-mode-waypoint').classList.toggle('active', newMode === 'waypoint');
    document.getElementById('btn-mode-freehand').classList.toggle('active', newMode === 'freehand');
    document.getElementById('btn-mode-compare').classList.toggle('active', newMode === 'compare');
    
    // Toggle dashboard views
    const scoringPanel = document.getElementById('scoring-panel');
    const comparePanel = document.getElementById('compare-panel');
    if (scoringPanel) scoringPanel.style.display = newMode === 'compare' ? 'none' : 'block';
    if (comparePanel) comparePanel.style.display = newMode === 'compare' ? 'block' : 'none';
    
    // Reset drawings
    clearAll();
    
    if (!silent) {
        let modeName = 'Waypoint Mode';
        if (newMode === 'freehand') modeName = 'Freehand Draw Mode';
        if (newMode === 'compare') modeName = 'Pace Compare Mode';
        showToast(`Switched to ${modeName}.`, 'info');
    }
    
    closeSidebarOnMobile();
}

function setActiveLayer(btnEl, layerKey) {
    document.querySelectorAll('.layer-btn').forEach(btn => btn.classList.remove('active'));
    btnEl.classList.add('active');
    switchBaseLayer(layerKey);
    closeSidebarOnMobile();
}

// State history for undo/redo
function saveState() {
    // Truncate forward history if we are drawing something new after an undo
    if (state.historyIndex < state.history.length - 1) {
        state.history = state.history.slice(0, state.historyIndex + 1);
    }
    
    state.history.push({
        waypoints: JSON.parse(JSON.stringify(state.waypoints)),
        freehandTrack: JSON.parse(JSON.stringify(state.freehandTrack))
    });
    state.historyIndex = state.history.length - 1;
    
    updateHistoryButtons();
}

function undo() {
    if (state.historyIndex > 0) {
        state.historyIndex--;
        const prev = state.history[state.historyIndex];
        state.waypoints = JSON.parse(JSON.stringify(prev.waypoints));
        state.freehandTrack = JSON.parse(JSON.stringify(prev.freehandTrack));
        
        updateHistoryButtons();
        
        if (state.mode === 'waypoint') {
            renderWaypointMode();
        } else {
            if (state.freehandTrack.length > 0) {
                processFreehandTrack();
            } else {
                clearDrawings();
                updateScoreDashboard(0, 0, 'free', [], 0, 0);
            }
        }
        showToast('Undone last action.', 'info');
    }
}

function redo() {
    if (state.historyIndex < state.history.length - 1) {
        state.historyIndex++;
        const next = state.history[state.historyIndex];
        state.waypoints = JSON.parse(JSON.stringify(next.waypoints));
        state.freehandTrack = JSON.parse(JSON.stringify(next.freehandTrack));
        
        updateHistoryButtons();
        
        if (state.mode === 'waypoint') {
            renderWaypointMode();
        } else {
            if (state.freehandTrack.length > 0) {
                processFreehandTrack();
            }
        }
        showToast('Redone last action.', 'info');
    }
}

function updateHistoryButtons() {
    document.getElementById('btn-undo').disabled = state.historyIndex <= 0;
    document.getElementById('btn-redo').disabled = state.historyIndex >= state.history.length - 1;
}

function clearAll() {
    state.waypoints = [];
    state.freehandTrack = [];
    state.compareTracks = [];
    state.activeSavedId = null;
    state.compareUtcOffset = 'auto';
    
    const tzSelect = document.getElementById('compare-timezone');
    if (tzSelect) tzSelect.value = 'auto';
    
    saveState();
    
    clearDrawings();
    updateScoreDashboard(0, 0, 'free', [], 0, 0);
    updateActiveTrackDisplay(null);
    
    highlightActiveSavedItem();
    
    if (state.mode === 'compare') {
        renderCompareMode();
    }
}

function clearDrawings() {
    clearMapLayers();
    if (state.drawings.trackLine) state.drawings.trackLine.setLatLngs([]);
    if (state.drawings.optLine) state.drawings.optLine.setLatLngs([]);
}

function clearMapLayers() {
    // Remove markers
    state.drawings.markers.forEach(m => state.map.removeLayer(m));
    state.drawings.markers = [];
    
    // Clear FAI Wedges
    if (state.drawings.wedges) {
        state.drawings.wedges.clearLayers();
    }

    // Remove closing circles
    if (state.drawings.closingCircle) {
        state.drawings.closingCircle.clearLayers();
    }

    // Clear Pace Compare drawings
    if (state.drawings.compareTracksGroup) {
        state.drawings.compareTracksGroup.clearLayers();
    }
    if (state.drawings.compareNodesGroup) {
        state.drawings.compareNodesGroup.clearLayers();
    }
    if (state.drawings.compareLinesGroup) {
        state.drawings.compareLinesGroup.clearLayers();
    }

    // Remove simplified line trace
    if (state.drawings.simplifiedLine) {
        state.map.removeLayer(state.drawings.simplifiedLine);
        state.drawings.simplifiedLine = null;
    }
}

function clearOptimizedMarkersOnly() {
    state.drawings.markers = state.drawings.markers.filter(m => {
        if (!m.isWaypointMarker) {
            state.map.removeLayer(m);
            return false;
        }
        return true;
    });
}

function updateWaypointOverlaysOnly() {
    const wps = state.waypoints;
    const len = wps.length;
    
    // Clear FAI Wedges
    if (state.drawings.wedges) {
        state.drawings.wedges.clearLayers();
    }
    // Remove closing circles
    if (state.drawings.closingCircle) {
        state.drawings.closingCircle.clearLayers();
    }
    // Remove only the optimized markers (large start/finish/turnpoint pins)
    clearOptimizedMarkersOnly();
    
    // Update raw clicked track line
    state.drawings.trackLine.setLatLngs(wps);

    if (len === 0) {
        updateScoreDashboard(0, 0, 'free', [], 0, 0);
    }
    else if (len === 1) {
        updateScoreDashboard(0, 0, 'free', [], 0, 0);
    }
    else if (len === 2) {
        const dist = vincentyDistance(wps[0], wps[1]);
        updateScoreDashboard(dist * 1.0, dist, 'free', [dist], 0, 0);
        drawFAIWedges(wps[0], wps[1]);
    }
    else if (len === 3) {
        const result = optimizeTrack(wps);
        if (result) {
            renderOptimizedOverlays(result, wps);
        }
        
        // Draw FAI wedges for all 3 legs of the triangle directly from waypoints
        drawFAIWedges(wps[0], wps[1], wps[2]);
        drawFAIWedges(wps[1], wps[2], wps[0]);
        drawFAIWedges(wps[2], wps[0], wps[1]);
        
        // Draw closing circles around start point directly from waypoints
        const perimeter = vincentyDistance(wps[0], wps[1]) + vincentyDistance(wps[1], wps[2]) + vincentyDistance(wps[2], wps[0]);
        drawClosingCircles(wps[0], perimeter);
    }
    else {
        const result = optimizeTrack(wps);
        if (result) {
            renderOptimizedOverlays(result, wps);
        }
        
        // Draw FAI wedges for the 3 legs of the turnpoints triangle directly from waypoints
        drawFAIWedges(wps[1], wps[2], wps[3]);
        drawFAIWedges(wps[2], wps[3], wps[1]);
        drawFAIWedges(wps[3], wps[1], wps[2]);
        
        // Draw closing circles around start point directly from waypoints
        const perimeter = vincentyDistance(wps[1], wps[2]) + vincentyDistance(wps[2], wps[3]) + vincentyDistance(wps[3], wps[1]);
        drawClosingCircles(wps[0], perimeter);
    }
}

function updateActiveTrackDisplay(name) {
    const banner = document.getElementById('active-track-banner');
    const nameEl = document.getElementById('active-track-name');
    if (!banner || !nameEl) return;
    
    if (name) {
        nameEl.textContent = name;
        banner.style.display = 'flex';
    } else {
        nameEl.textContent = '';
        banner.style.display = 'none';
    }
}

// Update the floating dashboard panel with new stats
function updateScoreDashboard(points, dist, type, legs, gap, gapPercent) {
    // Cache stats in state
    state.currentStats = { points, dist, type, legs, gap, gapPercent };

    // 1. Points value
    const pointsValEl = document.getElementById('score-value');
    pointsValEl.innerText = points.toFixed(2);
    
    const panelEl = document.querySelector('.points-display');
    panelEl.className = 'points-display'; // Reset categories
    panelEl.classList.add(`scoring-${type}`);
    
    // 2. Distance value
    document.getElementById('stat-distance').innerText = `${dist.toFixed(2)} km`;
    
    // 3. Category Label
    const catEl = document.getElementById('stat-category');
    catEl.className = 'stat-value';
    catEl.classList.add(`category-${type}`);
    
    let typeName = 'Free Flight';
    if (type === 'free_tri') typeName = 'Free Triangle';
    if (type === 'fai') typeName = 'FAI Triangle';
    if (type === 'closed_free') typeName = 'Closed Free Tri';
    if (type === 'closed_fai') typeName = 'Closed FAI Tri';
    catEl.innerText = typeName;
    
    // 4. Gap Closure Details
    const gapEl = document.getElementById('stat-gap');
    gapEl.innerText = `${gap.toFixed(2)} km`;
    
    const badgeEl = document.getElementById('gap-warning');
    badgeEl.innerText = `${gapPercent.toFixed(1)}%`;
    
    const progressBar = document.getElementById('gap-progress-bar');
    
    if (gapPercent === 0) {
        badgeEl.className = 'badge badge-ok';
        badgeEl.innerText = '0.0%';
        progressBar.style.backgroundColor = 'var(--color-closed-fai)';
        progressBar.style.width = '0%';
    } else if (gapPercent < 5.0) {
        badgeEl.className = 'badge badge-ok';
        progressBar.style.backgroundColor = 'var(--color-closed-fai)';
        progressBar.style.width = `${(gapPercent / 20.0) * 100}%`;
    } else if (gapPercent <= 20.0) {
        badgeEl.className = 'badge badge-ok';
        progressBar.style.backgroundColor = 'var(--color-closed-free)';
        progressBar.style.width = `${(gapPercent / 20.0) * 100}%`;
    } else {
        badgeEl.className = 'badge badge-warn';
        progressBar.style.backgroundColor = 'var(--color-danger)';
        progressBar.style.width = '100%';
    }

    // 5. Leg lengths details
    const totalLegs = legs.reduce((a, b) => a + b, 0);
    
    const updateLegUI = (index, value) => {
        const valEl = document.getElementById(`leg${index}-val`);
        const pctEl = document.getElementById(`leg${index}-pct`);
        const itemEl = valEl.closest('.leg-item');
        
        itemEl.className = 'leg-item'; // Reset classes
        
        if (value > 0) {
            const pct = (value / totalLegs) * 100;
            valEl.innerText = `${value.toFixed(1)} km`;
            pctEl.innerText = `${pct.toFixed(1)}%`;
            
            if (pct >= 28.0) {
                itemEl.classList.add('valid-fai');
            } else {
                itemEl.classList.add('invalid');
            }
        } else {
            valEl.innerText = '0.0 km';
            pctEl.innerText = '0.0%';
        }
    };
    
    updateLegUI(1, legs[0] || 0);
    updateLegUI(2, legs[1] || 0);
    updateLegUI(3, legs[2] || 0);

    // 6. Shortest Leg Badge
    const shortestLegBadge = document.getElementById('shortest-leg-badge');
    if (legs.length >= 3) {
        const minLeg = Math.min(...legs);
        const minPct = (minLeg / totalLegs) * 100;
        shortestLegBadge.innerText = `${minPct.toFixed(1)}% min`;
        shortestLegBadge.className = minPct >= 28.0 ? 'badge badge-ok' : 'badge badge-warn';
    } else {
        shortestLegBadge.innerText = 'No legs';
        shortestLegBadge.className = 'badge';
    }
}

// Display simple toasts to give immediate user feedback
function showToast(message, type = 'info') {
    // Remove existing toast if present
    const oldToast = document.querySelector('.toast-msg');
    if (oldToast) oldToast.remove();
    
    const toast = document.createElement('div');
    toast.className = `toast-msg toast-${type}`;
    toast.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
        </svg>
        <span>${message}</span>
    `;
    
    document.body.appendChild(toast);
    
    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 50);
    
    // Auto-remove after 4 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

/// ==========================================
// 8. SAVED ROUTES & TRACKS MANAGER
// ==========================================

function saveCurrentFlight() {
    let type = '';
    let points = [];
    
    if (state.mode === 'waypoint' && state.waypoints.length > 0) {
        type = 'route';
        points = [...state.waypoints];
    } else if (state.mode === 'freehand' && state.freehandTrack.length > 0) {
        type = 'track';
        points = [...state.freehandTrack];
    }
    
    if (points.length === 0) {
        showToast('No active route or track on the map to save!', 'info');
        return;
    }
    
    // Suggest a default name
    let defaultName = '';
    if (type === 'route') {
        defaultName = `Waypoint Route (${points.length} pts)`;
    } else {
        const bannerEl = document.getElementById('active-track-name');
        if (bannerEl && bannerEl.textContent && bannerEl.textContent !== 'No track loaded' && bannerEl.textContent !== 'Freehand Sketch') {
            defaultName = bannerEl.textContent.replace('Uploaded File: ', '');
        } else {
            const dist = state.currentStats?.dist || 0;
            defaultName = `Flight Track (${dist.toFixed(1)} km)`;
        }
    }
    
    const name = prompt('Enter a name for this saved item:', defaultName);
    if (name === null) return; // Cancelled
    
    const finalName = name.trim() || defaultName;
    
    const newItem = {
        id: Date.now(),
        name: finalName,
        type: type,
        points: points,
        stats: state.currentStats ? { ...state.currentStats } : null
    };
    
    // Load existing items from localStorage
    const savedStr = localStorage.getItem('xc_saved_items');
    let savedItems = [];
    if (savedStr) {
        try {
            savedItems = JSON.parse(savedStr);
        } catch (e) {
            console.error('Failed to parse saved items', e);
        }
    }
    
    // Prepend new item
    savedItems.unshift(newItem);
    
    // Save to localStorage
    localStorage.setItem('xc_saved_items', JSON.stringify(savedItems));
    
    state.activeSavedId = newItem.id;
    renderSavedList();
    
    // If it's a track, we need to update active track display name to what user entered
    if (type === 'track') {
        updateActiveTrackDisplay(`Saved Track: ${finalName}`);
    } else {
        updateActiveTrackDisplay(`Saved Route: ${finalName}`);
    }
    
    showToast(`Saved: ${finalName}`, 'success');
}

function renderSavedList() {
    const listContainer = document.getElementById('saved-list');
    if (!listContainer) return;
    
    const savedStr = localStorage.getItem('xc_saved_items');
    let savedItems = [];
    if (savedStr) {
        try {
            savedItems = JSON.parse(savedStr);
        } catch (e) {
            console.error('Failed to parse saved items', e);
        }
    }
    
    if (savedItems.length === 0) {
        listContainer.innerHTML = `<div class="no-saved-routes">No saved routes or tracks yet. Draw a route or upload a track, then click "Save Current"!</div>`;
        return;
    }
    
    listContainer.innerHTML = '';
    savedItems.forEach(item => {
        const card = document.createElement('div');
        card.className = 'saved-item-card';
        if (item.id === state.activeSavedId) {
            card.classList.add('active');
        }
        card.dataset.id = item.id;
        
        let metaText = '';
        if (item.type === 'route') {
            const dist = item.stats?.dist || 0;
            metaText = `Waypoint Route • ${item.points.length} pts • ${dist.toFixed(1)} km`;
        } else {
            const score = item.stats?.points || item.stats?.score || 0;
            const dist = item.stats?.dist || 0;
            let cat = item.stats?.type || 'free';
            let catName = 'Free';
            if (cat === 'free_tri') catName = 'Free Tri';
            if (cat === 'fai') catName = 'FAI Tri';
            if (cat === 'closed_free') catName = 'Closed Free';
            if (cat === 'closed_fai') catName = 'Closed FAI';
            metaText = `${catName} Track • ${score.toFixed(2)} pts • ${dist.toFixed(1)} km`;
        }
        
        card.innerHTML = `
            <button class="saved-item-load-btn" title="Load this item">
                <span class="saved-item-title">${escapeHTML(item.name)}</span>
                <span class="saved-item-meta">${metaText}</span>
            </button>
            <button class="saved-item-delete-btn" title="Delete saved item">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
        `;
        
        // Load event listener
        card.querySelector('.saved-item-load-btn').addEventListener('click', () => {
            loadSavedItem(item.id);
        });
        
        // Delete event listener
        card.querySelector('.saved-item-delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteSavedItem(item.id);
        });
        
        listContainer.appendChild(card);
    });
}

function loadSavedItem(id) {
    const savedStr = localStorage.getItem('xc_saved_items');
    if (!savedStr) return;
    let savedItems = [];
    try {
        savedItems = JSON.parse(savedStr);
    } catch (e) {
        console.error('Failed to parse saved items', e);
        return;
    }
    
    const item = savedItems.find(item => item.id === id);
    if (!item) return;
    
    if (state.mode === 'compare') {
        if (item.type === 'route') {
            showToast("Cannot load a waypoint route into Pace Comparison.", "warning");
            return;
        }
        
        // Load the saved track into pace comparison
        const colors = ['#00f2fe', '#a855f7', '#f59e0b', '#10b981', '#ec4899', '#3b82f6'];
        const trackColor = colors[state.compareTracks.length % colors.length];
        
        // Ensure timestamps exist
        const points = ensureTimestamps(JSON.parse(JSON.stringify(item.points)));
        
        const newTrack = {
            id: Date.now() + Math.random(),
            name: item.name,
            points: points,
            color: trackColor,
            visible: true
        };
        
        state.compareTracks.push(newTrack);
        updateTrackLocalTimes();
        renderCompareMode();
        
        // Zoom map to fit all compared tracks combined
        const allPoints = [];
        state.compareTracks.forEach(t => {
            if (t.visible) allPoints.push(...t.points);
        });
        if (allPoints.length > 0) {
            const polyline = L.polyline(allPoints);
            state.map.fitBounds(polyline.getBounds(), { padding: [45, 45] });
        }
        
        showToast(`Added track: ${newTrack.name} to comparison.`, 'success');
        closeSidebarOnMobile();
        return;
    }
    
    // Switch mode first (toggles panels, buttons, and runs clearAll)
    setMode(item.type === 'route' ? 'waypoint' : 'freehand', true);
    
    state.activeSavedId = item.id;
    
    if (item.type === 'route') {
        state.waypoints = JSON.parse(JSON.stringify(item.points));
        saveState();
        renderWaypointMode();
        
        if (state.waypoints.length > 0) {
            const polyline = L.polyline(state.waypoints);
            state.map.fitBounds(polyline.getBounds(), { padding: [45, 45] });
        }
        updateActiveTrackDisplay(`Saved Route: ${item.name}`);
    } else {
        state.freehandTrack = JSON.parse(JSON.stringify(item.points));
        saveState();
        
        // Process track
        processFreehandTrack();
        
        if (state.freehandTrack.length > 0) {
            const polyline = L.polyline(state.freehandTrack);
            state.map.fitBounds(polyline.getBounds(), { padding: [45, 45] });
        }
        updateActiveTrackDisplay(`Saved Track: ${item.name}`);
    }
    
    state.activeSavedId = item.id; // needs to be set again since clearAll() nulls it
    highlightActiveSavedItem();
    
    showToast(`Loaded: ${item.name}`, 'success');
    closeSidebarOnMobile();
}

function deleteSavedItem(id) {
    if (!confirm('Are you sure you want to delete this saved item?')) return;
    
    const savedStr = localStorage.getItem('xc_saved_items');
    if (!savedStr) return;
    let savedItems = [];
    try {
        savedItems = JSON.parse(savedStr);
    } catch (e) {
        console.error('Failed to parse saved items', e);
        return;
    }
    
    const itemToDelete = savedItems.find(item => item.id === id);
    savedItems = savedItems.filter(item => item.id !== id);
    localStorage.setItem('xc_saved_items', JSON.stringify(savedItems));
    
    if (state.activeSavedId === id) {
        state.activeSavedId = null;
        clearAll();
    }
    
    renderSavedList();
    if (itemToDelete) {
        showToast(`Deleted: ${itemToDelete.name}`, 'info');
    }
}

function highlightActiveSavedItem() {
    document.querySelectorAll('.saved-item-card').forEach(card => {
        const id = parseInt(card.dataset.id);
        if (id === state.activeSavedId) {
            card.classList.add('active');
        } else {
            card.classList.remove('active');
        }
    });
}

function escapeHTML(str) {
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
}

// Parse standard IGC paragliding track text
function parseIGC(text) {
    const points = [];
    const lines = text.split(/\r?\n/);
    for (let line of lines) {
        line = line.trim();
        if (line.startsWith('B') && line.length >= 24) {
            try {
                // Lat: DDMMmmmN/S (8 chars)
                const latStr = line.substring(7, 15);
                const latDeg = parseInt(latStr.substring(0, 2), 10);
                const latMin = parseInt(latStr.substring(2, 7), 10) / 1000;
                let lat = latDeg + latMin / 60;
                if (latStr.charAt(7) === 'S') lat = -lat;

                // Lng: DDDMMmmmE/W (9 chars)
                const lngStr = line.substring(15, 24);
                const lngDeg = parseInt(lngStr.substring(0, 3), 10);
                const lngMin = parseInt(lngStr.substring(3, 8), 10) / 1000;
                let lng = lngDeg + lngMin / 60;
                if (lngStr.charAt(8) === 'W') lng = -lng;

                // Time: HHMMSS (6 chars) starting at index 1
                const timeStr = line.substring(1, 7);
                const hrs = parseInt(timeStr.substring(0, 2), 10);
                const mins = parseInt(timeStr.substring(2, 4), 10);
                const secs = parseInt(timeStr.substring(4, 6), 10);
                const time = hrs * 3600 + mins * 60 + secs;

                if (!isNaN(lat) && !isNaN(lng)) {
                    points.push({ lat, lng, time });
                }
            } catch (e) {
                // Ignore malformed lines
            }
        }
    }
    return points;
}

// Parse GPX track log xml
function parseGPX(text) {
    const points = [];
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    const trkpts = xml.getElementsByTagName('trkpt');
    for (let i = 0; i < trkpts.length; i++) {
        const lat = parseFloat(trkpts[i].getAttribute('lat'));
        const lng = parseFloat(trkpts[i].getAttribute('lon'));
        
        // Parse time tag if exists
        const timeEl = trkpts[i].getElementsByTagName('time')[0];
        let time = undefined;
        if (timeEl && timeEl.textContent) {
            try {
                const d = new Date(timeEl.textContent);
                if (!isNaN(d.getTime())) {
                    time = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
                }
            } catch (e) {
                // Ignore timestamp error
            }
        }
        
        if (!isNaN(lat) && !isNaN(lng)) {
            if (time !== undefined) {
                points.push({ lat, lng, time });
            } else {
                points.push({ lat, lng });
            }
        }
    }
    return points;
}

// Parse KML track log xml
function parseKML(text) {
    const points = [];
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    const coordTags = xml.getElementsByTagName('coordinates');
    for (let i = 0; i < coordTags.length; i++) {
        const coordsText = coordTags[i].textContent.trim();
        const coordPairs = coordsText.split(/\s+/);
        for (let pair of coordPairs) {
            const parts = pair.split(',');
            if (parts.length >= 2) {
                const lng = parseFloat(parts[0]);
                const lat = parseFloat(parts[1]);
                if (!isNaN(lat) && !isNaN(lng)) {
                    points.push({ lat, lng });
                }
            }
        }
    }
    return points;
}

// Ensure timestamps exist for Pace Comparison
function ensureTimestamps(points) {
    if (!points || points.length === 0) return [];
    
    // Check if points already have valid processed timestamps (loaded from saved items)
    const hasUtc = points.some(p => p.utcTime !== undefined && !isNaN(p.utcTime));
    if (hasUtc) {
        return points;
    }
    
    // Check if points already have valid timestamps
    const hasTime = points.some(p => p.time !== undefined && !isNaN(p.time) && p.time > 0);
    if (hasTime) {
        // First, handle any midnight wrap-around to make timestamps strictly increasing
        let dayOffset = 0;
        let prevRawTime = -1;
        for (let i = 0; i < points.length; i++) {
            if (points[i].time !== undefined && !isNaN(points[i].time)) {
                const rawTime = points[i].time;
                if (prevRawTime !== -1 && rawTime < prevRawTime - 43200) {
                    dayOffset += 86400;
                }
                points[i].time = rawTime + dayOffset;
                prevRawTime = rawTime;
            }
        }

        // Linearly interpolate any missing intermediate timestamps
        let lastTime = (points[0].time !== undefined && !isNaN(points[0].time)) ? points[0].time : (43200 - getLocalOffsetHours(points) * 3600);
        for (let i = 0; i < points.length; i++) {
            if (points[i].time === undefined || isNaN(points[i].time)) {
                // Find next point with valid timestamp to interpolate
                let nextIdx = -1;
                for (let j = i + 1; j < points.length; j++) {
                    if (points[j].time !== undefined && !isNaN(points[j].time)) {
                        nextIdx = j;
                        break;
                    }
                }
                if (nextIdx !== -1) {
                    const step = (points[nextIdx].time - lastTime) / (nextIdx - i + 1);
                    for (let k = i; k < nextIdx; k++) {
                        points[k].time = Math.round(lastTime + step * (k - i + 1));
                    }
                    i = nextIdx - 1;
                } else {
                    // No future timestamp, just increment by 1 sec
                    points[i].time = lastTime + 1;
                }
            }
            lastTime = points[i].time;
        }
    } else {
        // Interpolate timestamps based on cumulative Vincenty distance
        // Assumes standard paraglider speed: 30 km/h = 0.00833 km/s
        // Starts at 12:00:00 Local Time (43200 seconds local, offset-adjusted for UTC)
        let cumulativeDist = 0;
        const offsetHours = getLocalOffsetHours(points);
        const startTime = 43200 - offsetHours * 3600;
        points[0].time = startTime;
        for (let i = 1; i < points.length; i++) {
            const d = vincentyDistance(points[i - 1], points[i]);
            cumulativeDist += d;
            points[i].time = startTime + Math.round(cumulativeDist / 0.00833);
        }
    }

    // Assign monotonic utcTime reference and project to local solar time
    const offset = getLocalOffsetHours(points);
    points.forEach(p => {
        p.utcTime = p.time;
        p.time = (p.utcTime + offset * 3600 + 86400 * 2) % 86400;
    });

    return points;
}

// Setup a clean callback for loaded tracks
function loadImportedTrack(points, label) {
    // Ensure timestamps exist for the track points
    points = ensureTimestamps(points);

    if (state.mode === 'compare') {
        const colors = ['#00f2fe', '#a855f7', '#f59e0b', '#10b981', '#ec4899', '#3b82f6'];
        const trackColor = colors[state.compareTracks.length % colors.length];
        
        const newTrack = {
            id: Date.now() + Math.random(),
            name: label.replace('Uploaded File: ', ''),
            points: points,
            color: trackColor,
            visible: true
        };
        
        state.compareTracks.push(newTrack);
        updateTrackLocalTimes();
        renderCompareMode();
        
        // Zoom map to fit all compared tracks combined
        const allPoints = [];
        state.compareTracks.forEach(t => {
            if (t.visible) allPoints.push(...t.points);
        });
        if (allPoints.length > 0) {
            const polyline = L.polyline(allPoints);
            state.map.fitBounds(polyline.getBounds(), { padding: [45, 45] });
        }
        
        showToast(`Added track: ${newTrack.name} to comparison.`, 'success');
        closeSidebarOnMobile();
        return;
    }

    // Switch to freehand mode silently (handles button styles, panels, and clearAll)
    setMode('freehand', true);
    
    state.freehandTrack = points;
    saveState();
    
    updateActiveTrackDisplay(label);
    
    // Process and optimize the track
    processFreehandTrack();
    
    // Zoom and center map to fit track
    const polyline = L.polyline(points);
    state.map.fitBounds(polyline.getBounds(), { padding: [40, 40] });
    
    showToast(`Loaded track: ${label}. Drag to pan. Hold Shift + Drag to redraw.`, 'success');
    closeSidebarOnMobile();
}

/**
 * Vincenty's Inverse Formula to compute geodesic distance on the WGS-84 ellipsoid
 * @param {Object} p1 - First point {lat, lng}
 * @param {Object} p2 - Second point {lat, lng}
 * @returns {Number} Geodesic distance in kilometers
 */
function vincentyDistance(p1, p2) {
    if (!p1 || !p2) return 0;
    const lat1 = p1.lat * Math.PI / 180;
    const lon1 = p1.lng * Math.PI / 180;
    const lat2 = p2.lat * Math.PI / 180;
    const lon2 = p2.lng * Math.PI / 180;

    const a = 6378137.0; // WGS-84 semi-major axis (meters)
    const f = 1 / 298.257223563; // WGS-84 flattening
    const b = 6356752.314245; // WGS-84 semi-minor axis (meters)

    const L = lon2 - lon1;
    const U1 = Math.atan((1 - f) * Math.tan(lat1));
    const U2 = Math.atan((1 - f) * Math.tan(lat2));

    const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
    const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

    let lambda = L;
    let lambdaP;
    let iterLimit = 100;
    let cosSqAlpha = 0;
    let cos2SigmaM = 0;
    let sinSigma = 0;
    let cosSigma = 0;
    let sigma = 0;

    do {
        const sinLambda = Math.sin(lambda);
        const cosLambda = Math.cos(lambda);
        sinSigma = Math.sqrt((cosU2 * sinLambda) * (cosU2 * sinLambda) +
                             (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) * (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda));
        if (sinSigma === 0) return 0; // co-incident points

        cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
        sigma = Math.atan2(sinSigma, cosSigma);

        const sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
        cosSqAlpha = 1 - sinAlpha * sinAlpha;
        cos2SigmaM = (cosSqAlpha === 0) ? 0 : cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha;

        const C = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
        lambdaP = lambda;
        lambda = L + (1 - C) * f * sinAlpha * (
            sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM))
        );
    } while (Math.abs(lambda - lambdaP) > 1e-12 && --iterLimit > 0);

    if (iterLimit === 0) {
        // failed to converge: fallback to haversine with WGS84 radius
        return haversineDistance(p1, p2) * (6378.137 / 6371.0);
    }

    const uSq = cosSqAlpha * (a * a - b * b) / (b * b);
    const A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    const deltaSigma = B * sinSigma * (
        cos2SigmaM + B / 4 * (
            cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            B / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)
        )
    );

    const s = b * A * (sigma - deltaSigma);
    return s / 1000; // in kilometers
}

/**
 * Performs hierarchical coordinate descent refinement on the raw unsimplified track
 * @param {Array} rawPoints - Unsimplified track points [{lat, lng}, ...]
 * @param {Object} optResult - Coarse optimization result on simplified track
 * @param {Array} mappingToRaw - Mapping of simplified point indices to rawPoint indices
 * @returns {Object} Refined optimization result containing raw indices and refined coordinates
 */
function refineOptimizedFlight(rawPoints, optResult, mappingToRaw) {
    const simplifiedIndices = optResult.indices;
    if (!simplifiedIndices || simplifiedIndices.length < 2) {
        return optResult;
    }

    const M = mappingToRaw.length;
    const W = 4; // Search window in simplified indices

    if (optResult.type === 'free') {
        const K = simplifiedIndices.length;
        const currIndices = simplifiedIndices.map(idx => mappingToRaw[idx]);

        // Search boundaries
        const minRaw = [];
        const maxRaw = [];
        for (let j = 0; j < K; j++) {
            const idx = simplifiedIndices[j];
            minRaw.push(mappingToRaw[Math.max(0, idx - W)]);
            maxRaw.push(mappingToRaw[Math.min(M - 1, idx + W)]);
        }

        // 5 iterations of coordinate descent
        for (let iter = 0; iter < 5; iter++) {
            for (let j = 0; j < K; j++) {
                let bestIdx = currIndices[j];
                let maxDistSum = -1;

                const startRange = minRaw[j];
                const endRange = maxRaw[j];

                const lowerBound = j > 0 ? currIndices[j - 1] + 1 : startRange;
                const upperBound = j < K - 1 ? currIndices[j + 1] - 1 : endRange;

                for (let i = Math.max(startRange, lowerBound); i <= Math.min(endRange, upperBound); i++) {
                    let distSum = 0;
                    if (j > 0) {
                        distSum += vincentyDistance(rawPoints[currIndices[j - 1]], rawPoints[i]);
                    }
                    if (j < K - 1) {
                        distSum += vincentyDistance(rawPoints[i], rawPoints[currIndices[j + 1]]);
                    }

                    if (distSum > maxDistSum) {
                        maxDistSum = distSum;
                        bestIdx = i;
                    }
                }
                currIndices[j] = bestIdx;
            }
        }

        const refinedLegs = [];
        let totalDist = 0;
        for (let j = 0; j < K - 1; j++) {
            const d = vincentyDistance(rawPoints[currIndices[j]], rawPoints[currIndices[j + 1]]);
            refinedLegs.push(d);
            totalDist += d;
        }

        return {
            score: totalDist * 1.0,
            distance: totalDist,
            type: 'free',
            indices: currIndices,
            legLengths: refinedLegs,
            gap: 0,
            gapPercent: 0,
            refinedPoints: currIndices.map(idx => rawPoints[idx])
        };
    } else {
        if (simplifiedIndices.length < 5) return optResult;

        const idx_s = simplifiedIndices[0];
        const idx_1 = simplifiedIndices[1];
        const idx_2 = simplifiedIndices[2];
        const idx_3 = simplifiedIndices[3];
        const idx_f = simplifiedIndices[4];

        const r_s_min = mappingToRaw[Math.max(0, idx_s - W)];
        const r_s_max = mappingToRaw[Math.min(M - 1, idx_s + W)];

        const r_1_min = mappingToRaw[Math.max(0, idx_1 - W)];
        const r_1_max = mappingToRaw[Math.min(M - 1, idx_1 + W)];

        const r_2_min = mappingToRaw[Math.max(0, idx_2 - W)];
        const r_2_max = mappingToRaw[Math.min(M - 1, idx_2 + W)];

        const r_3_min = mappingToRaw[Math.max(0, idx_3 - W)];
        const r_3_max = mappingToRaw[Math.min(M - 1, idx_3 + W)];

        const r_f_min = mappingToRaw[Math.max(0, idx_f - W)];
        const r_f_max = mappingToRaw[Math.min(M - 1, idx_f + W)];

        let curr_s = mappingToRaw[idx_s];
        let curr_1 = mappingToRaw[idx_1];
        let curr_2 = mappingToRaw[idx_2];
        let curr_3 = mappingToRaw[idx_3];
        let curr_f = mappingToRaw[idx_f];

        const getScoreForCombo = (s, i1, i2, i3, f) => {
            const d12 = vincentyDistance(rawPoints[i1], rawPoints[i2]);
            const d23 = vincentyDistance(rawPoints[i2], rawPoints[i3]);
            const d31 = vincentyDistance(rawPoints[i3], rawPoints[i1]);
            const P = d12 + d23 + d31;
            const gap = vincentyDistance(rawPoints[s], rawPoints[f]);
            const gapPercent = P > 0 ? (gap / P) * 100 : 999.0;

            const scoredDist = P - gap;
            const shortestLeg = Math.min(d12, d23, d31);
            const isFai = shortestLeg >= 0.28 * P;
            const isClosed = gapPercent < 5.0;

            let coeff = 1.0;
            if (gapPercent <= 20.0) {
                if (isFai && isClosed) {
                    coeff = 1.60;
                } else if (isFai && !isClosed) {
                    coeff = 1.40;
                } else if (!isFai && isClosed) {
                    coeff = 1.40;
                } else {
                    coeff = 1.20;
                }
            }
            return {
                score: scoredDist * coeff,
                distance: scoredDist,
                gap: gap,
                gapPercent: gapPercent,
                legs: [d12, d23, d31]
            };
        };

        // 5 iterations for turnpoints coordinate descent
        for (let iter = 0; iter < 5; iter++) {
            // 1. Optimize curr_1
            let bestScore = -1;
            let bestIdx = curr_1;
            for (let i = Math.max(curr_s, r_1_min); i <= Math.min(r_1_max, curr_2 - 1); i++) {
                const res = getScoreForCombo(curr_s, i, curr_2, curr_3, curr_f);
                if (res.score > bestScore) {
                    bestScore = res.score;
                    bestIdx = i;
                }
            }
            curr_1 = bestIdx;

            // 2. Optimize curr_2
            bestScore = -1;
            bestIdx = curr_2;
            for (let i = Math.max(curr_1 + 1, r_2_min); i <= Math.min(r_2_max, curr_3 - 1); i++) {
                const res = getScoreForCombo(curr_s, curr_1, i, curr_3, curr_f);
                if (res.score > bestScore) {
                    bestScore = res.score;
                    bestIdx = i;
                }
            }
            curr_2 = bestIdx;

            // 3. Optimize curr_3
            bestScore = -1;
            bestIdx = curr_3;
            for (let i = Math.max(curr_2 + 1, r_3_min); i <= Math.min(r_3_max, curr_f); i++) {
                const res = getScoreForCombo(curr_s, curr_1, curr_2, i, curr_f);
                if (res.score > bestScore) {
                    bestScore = res.score;
                    bestIdx = i;
                }
            }
            curr_3 = bestIdx;
        }

        // Optimize start/finish gap once at the end
        for (let iter = 0; iter < 3; iter++) {
            let bestG = Infinity;
            let bestS = curr_s;
            for (let sIdx = r_s_min; sIdx <= Math.min(r_s_max, curr_1); sIdx++) {
                const g = vincentyDistance(rawPoints[sIdx], rawPoints[curr_f]);
                if (g < bestG) {
                    bestG = g;
                    bestS = sIdx;
                }
            }
            curr_s = bestS;

            let bestFIdx = curr_f;
            for (let fIdx = Math.max(curr_3, r_f_min); fIdx <= r_f_max; fIdx++) {
                const g = vincentyDistance(rawPoints[curr_s], rawPoints[fIdx]);
                if (g < bestG) {
                    bestG = g;
                    bestFIdx = fIdx;
                }
            }
            curr_f = bestFIdx;
        }

        const finalRes = getScoreForCombo(curr_s, curr_1, curr_2, curr_3, curr_f);
        const P = finalRes.legs[0] + finalRes.legs[1] + finalRes.legs[2];
        const isFai = Math.min(...finalRes.legs) >= 0.28 * P;
        const isClosed = finalRes.gapPercent < 5.0;

        let ftype = 'free_tri';
        if (finalRes.gapPercent <= 20.0) {
            if (isFai && isClosed) {
                ftype = 'closed_fai';
            } else if (isFai && !isClosed) {
                ftype = 'fai';
            } else if (!isFai && isClosed) {
                ftype = 'closed_free';
            } else {
                ftype = 'free_tri';
            }
        } else {
            ftype = 'free';
        }

        return {
            score: finalRes.score,
            distance: finalRes.distance,
            type: ftype,
            indices: [curr_s, curr_1, curr_2, curr_3, curr_f],
            legLengths: finalRes.legs,
            gap: finalRes.gap,
            gapPercent: finalRes.gapPercent,
            refinedPoints: [curr_s, curr_1, curr_2, curr_3, curr_f].map(idx => rawPoints[idx])
        };
    }
}

// ==========================================
// 10. PACE COMPARISON MODE CONTROLS
// ==========================================

function getColorForLocalSec(localSec) {
    if (typeof localSec === 'string') {
        // Fallback for safety in case of string input (e.g. older formats)
        const parts = localSec.split(':');
        const hrs = parseInt(parts[0], 10);
        const mins = parseInt(parts[1], 10);
        localSec = hrs * 3600 + mins * 60;
    }
    
    // We want a beautiful spectrum for the daylight hours (6:00 AM to 9:30 PM local)
    // 6 AM = 21600 seconds, 9:30 PM = 77400 seconds.
    const startSec = 6 * 3600; // 06:00
    const endSec = 21 * 3600 + 30 * 60; // 21:30
    
    if (localSec < startSec || localSec > endSec) {
        return "#6b7280"; // night/out-of-bounds is cool grey
    }
    
    const ratio = (localSec - startSec) / (endSec - startSec);
    
    // Map ratio to a continuous hue spectrum
    let hue = 0;
    if (ratio < 0.2) {
        // 06:00 to 09:00: Hue 45 (Yellow-Orange) -> 25 (Orange-Red)
        hue = 45 - (ratio / 0.2) * 20;
    } else if (ratio < 0.4) {
        // 09:00 to 12:00: Hue 25 -> 340 (Crimson/Pink-Red)
        hue = 25 - ((ratio - 0.2) / 0.2) * 45;
    } else if (ratio < 0.6) {
        // 12:00 to 15:00: Hue 340 -> 280 (Purple)
        hue = 340 - ((ratio - 0.4) / 0.2) * 60;
    } else if (ratio < 0.75) {
        // 15:00 to 17:30: Hue 280 -> 220 (Blue)
        hue = 280 - ((ratio - 0.6) / 0.15) * 60;
    } else if (ratio < 0.9) {
        // 17:30 to 20:00: Hue 220 -> 170 (Teal)
        hue = 220 - ((ratio - 0.75) / 0.15) * 50;
    } else {
        // 20:00 to 21:30: Hue 170 -> 120 (Green)
        hue = 170 - ((ratio - 0.9) / 0.1) * 50;
    }
    
    if (hue < 0) hue += 360;
    
    const saturation = 92; // 92% for high vibrance
    const lightness = 54; // 54% lightness
    
    return `hsl(${Math.round(hue)}, ${saturation}%, ${lightness}%)`;
}

function formatTimeStr(seconds) {
    const hrs24 = Math.floor(seconds / 3600) % 24;
    const mins = Math.floor((seconds % 3600) / 60);
    const ampm = hrs24 >= 12 ? 'PM' : 'AM';
    let hrs12 = hrs24 % 12;
    if (hrs12 === 0) hrs12 = 12;
    return `${hrs12.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')} ${ampm}`;
}

function getLocalOffsetHours(points) {
    if (state.compareUtcOffset !== 'auto') {
        return state.compareUtcOffset;
    }
    if (points && points.length > 0) {
        return Math.round(points[0].lng / 15);
    }
    if (state.compareTracks && state.compareTracks.length > 0) {
        const visible = state.compareTracks.filter(t => t.visible);
        const refTrack = visible.length > 0 ? visible[0] : state.compareTracks[0];
        if (refTrack && refTrack.points && refTrack.points.length > 0) {
            return Math.round(refTrack.points[0].lng / 15);
        }
    }
    return 0;
}

function getLocalSeconds(utcSeconds) {
    const offset = getLocalOffsetHours();
    return (utcSeconds + offset * 3600 + 86400 * 2) % 86400;
}

function updateTrackLocalTimes() {
    const offset = getLocalOffsetHours();
    state.compareTracks.forEach(track => {
        track.points.forEach(p => {
            if (p.utcTime !== undefined) {
                p.time = (p.utcTime + offset * 3600 + 86400 * 2) % 86400;
            }
        });
    });
}
 
function getInterpolatedPos(trackPoints, targetTime) {
    if (trackPoints.length < 2) return null;
    if (targetTime < trackPoints[0].time || targetTime > trackPoints[trackPoints.length - 1].time) {
        return null; // outside flight window
    }
    
    // Binary search for segment
    let low = 0;
    let high = trackPoints.length - 2;
    let idx = -1;
    
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (trackPoints[mid].time <= targetTime && trackPoints[mid + 1].time >= targetTime) {
            idx = mid;
            break;
        } else if (trackPoints[mid].time > targetTime) {
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }
    
    if (idx === -1) return null;
    
    const ptA = trackPoints[idx];
    const ptB = trackPoints[idx + 1];
    
    const diff = ptB.time - ptA.time;
    if (diff === 0) return { lat: ptA.lat, lng: ptA.lng };
    
    const f = (targetTime - ptA.time) / diff;
    return {
        lat: ptA.lat + f * (ptB.lat - ptA.lat),
        lng: ptA.lng + f * (ptB.lng - ptA.lng)
    };
}

function getNearestNeighborChain(nodes) {
    if (nodes.length <= 1) return nodes;
    
    const chain = [nodes[0]];
    const unvisited = nodes.slice(1);
    let current = nodes[0];
    
    while (unvisited.length > 0) {
        let nearestIdx = 0;
        let minDist = Infinity;
        
        for (let i = 0; i < unvisited.length; i++) {
            const node = unvisited[i];
            const dist = Math.sqrt((node.lat - current.lat) ** 2 + (node.lng - current.lng) ** 2);
            if (dist < minDist) {
                minDist = dist;
                nearestIdx = i;
            }
        }
        
        current = unvisited[nearestIdx];
        chain.push(current);
        unvisited.splice(nearestIdx, 1);
    }
    return chain;
}

function renderCompareMode() {
    // 1. Clear existing overlays
    clearMapLayers();
    
    const countEl = document.getElementById('compare-tracks-count');
    const listContainer = document.getElementById('compare-track-list');
    const legendContainer = document.getElementById('compare-legend');
    const slider = document.getElementById('compare-time-slider');
    
    if (!countEl || !listContainer || !legendContainer || !slider) return;
    
    const count = state.compareTracks.length;
    countEl.innerText = `${count} track${count === 1 ? '' : 's'} loaded`;
    
    if (count === 0) {
        listContainer.innerHTML = `<div class="no-saved-routes" style="padding: 10px 4px; font-size: 10px;">No tracks loaded yet. Upload track files (.igc, .gpx, .kml) while in Pace Compare mode to overlay them!</div>`;
        legendContainer.innerHTML = `<div style="grid-column: 1 / span 2; font-size: 9px; color: var(--text-muted); text-align: center; padding: 10px 0;">No legend timeline data</div>`;
        slider.disabled = true;
        slider.min = 0;
        slider.max = 0;
        slider.value = 0;
        document.getElementById('lbl-slider-time').innerText = "Show All Times";
        return;
    }
    
    // Render track cards in sidebar
    listContainer.innerHTML = '';
    state.compareTracks.forEach(track => {
        const startSec = track.points[0]?.time || 0;
        const endSec = track.points[track.points.length - 1]?.time || 0;
        const localStart = startSec;
        const localEnd = endSec;
        
        const card = document.createElement('div');
        card.className = 'compare-track-card';
        card.innerHTML = `
            <input type="checkbox" class="compare-track-checkbox" ${track.visible ? 'checked' : ''} title="Toggle visibility">
            <span class="compare-track-color-indicator" style="background-color: ${track.color};"></span>
            <div class="compare-track-info">
                <span class="compare-track-title" title="${track.name}">${escapeHTML(track.name)}</span>
                <span class="compare-track-meta">${formatTimeStr(localStart)} - ${formatTimeStr(localEnd)} Local</span>
            </div>
            <button class="compare-track-delete-btn" title="Delete track">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
        `;
        
        // Wire toggles
        card.querySelector('.compare-track-checkbox').addEventListener('change', () => {
            toggleCompareTrackVisibility(track.id);
        });
        
        // Wire deletes
        card.querySelector('.compare-track-delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteCompareTrack(track.id);
        });
        
        listContainer.appendChild(card);
    });
    
    // Draw each visible track line
    const visibleTracks = state.compareTracks.filter(t => t.visible);
    visibleTracks.forEach(track => {
        const polyline = L.polyline(track.points, {
            color: track.color,
            weight: 2,
            opacity: 0.45,
            interactive: false
        });
        polyline.addTo(state.drawings.compareTracksGroup);
    });
    
    if (visibleTracks.length === 0) {
        legendContainer.innerHTML = `<div style="grid-column: 1 / span 2; font-size: 9px; color: var(--text-muted); text-align: center; padding: 10px 0;">No visible tracks</div>`;
        slider.disabled = true;
        slider.min = 0;
        slider.max = 0;
        slider.value = 0;
        document.getElementById('lbl-slider-time').innerText = "Show All Times";
        return;
    }
    
    // Find absolute timebounds of visible tracks
    let minTime = Infinity;
    let maxTime = -Infinity;
    
    visibleTracks.forEach(t => {
        if (t.points[0]?.time < minTime) minTime = t.points[0].time;
        if (t.points[t.points.length - 1]?.time > maxTime) maxTime = t.points[t.points.length - 1].time;
    });
    
    if (minTime === Infinity || maxTime === -Infinity || minTime >= maxTime) {
        return; // invalid time bounds
    }
    
    // Round bounds to nearest half-hour marks
    const startHalfHour = Math.ceil(minTime / 1800) * 1800;
    const endHalfHour = Math.floor(maxTime / 1800) * 1800;
    
    const halfHours = [];
    for (let t = startHalfHour; t <= endHalfHour; t += 1800) {
        halfHours.push(t);
    }
    
    state.compareHalfHours = halfHours;
    
    // Render Nodes & Connecting Lines
    halfHours.forEach(T => {
        const timeStr = formatTimeStr(T);
        const color = getColorForLocalSec(T);
        const offset = getLocalOffsetHours();
        const utcSec = (T - offset * 3600 + 86400 * 2) % 86400;
        const utcTimeStr = formatTimeStr(utcSec);
        
        const activeNodes = [];
        visibleTracks.forEach(track => {
            const pos = getInterpolatedPos(track.points, T);
            if (pos) {
                activeNodes.push({
                    trackId: track.id,
                    lat: pos.lat,
                    lng: pos.lng
                });
            }
        });
        
        if (activeNodes.length >= 1) {
            // Draw nodes
            activeNodes.forEach(node => {
                const marker = L.marker([node.lat, node.lng], {
                    interactive: true,
                    icon: L.divIcon({
                        className: 'pace-node-marker',
                        html: `<div class="pace-node-dot" style="background-color: ${color}; color: ${color};"></div>`,
                        iconSize: [14, 14],
                        iconAnchor: [7, 7]
                    })
                }).addTo(state.drawings.compareNodesGroup);
                
                marker.compareTime = T;
                
                // Add popup showing flight details
                const track = state.compareTracks.find(t => t.id === node.trackId);
                marker.bindPopup(`
                    <div style="font-size: 11px; font-family: var(--font-sans);">
                        <strong style="color: ${track.color};">${escapeHTML(track.name)}</strong><br/>
                        Time: <strong>${timeStr} Local (${utcTimeStr} UTC)</strong><br/>
                        Pos: ${node.lat.toFixed(5)}, ${node.lng.toFixed(5)}
                    </div>
                `, { closeButton: false });
            });
        }
        
        if (activeNodes.length >= 2) {
            // Connect nodes using spatial nearest neighbor path
            const chain = getNearestNeighborChain(activeNodes);
            const pathCoords = chain.map(n => [n.lat, n.lng]);
            
            const polyline = L.polyline(pathCoords, {
                color: color,
                weight: 1.5,
                opacity: 0.75,
                dashArray: '2, 3',
                className: 'pace-sync-line',
                interactive: false
            }).addTo(state.drawings.compareLinesGroup);
            
            polyline.compareTime = T;
        }
    });
    
    // Build Timeline Legend
    legendContainer.innerHTML = '';
    if (halfHours.length === 0) {
        legendContainer.innerHTML = `<div style="grid-column: 1 / span 2; font-size: 9px; color: var(--text-muted); text-align: center; padding: 10px 0;">No overlapping half-hour steps</div>`;
    } else {
        halfHours.forEach(T => {
            const timeStr = formatTimeStr(T);
            const color = getColorForLocalSec(T);
            const item = document.createElement('div');
            item.className = 'legend-time-swatch';
            item.innerHTML = `<span class="legend-time-color" style="background-color: ${color};"></span>${timeStr} Local`;
            legendContainer.appendChild(item);
        });
    }
    
    // Update Slider limits
    if (halfHours.length > 0) {
        slider.disabled = false;
        slider.min = 0;
        slider.max = halfHours.length;
        slider.value = 0;
        document.getElementById('lbl-slider-time').innerText = "Show All Times";
    } else {
        slider.disabled = true;
        slider.min = 0;
        slider.max = 0;
        slider.value = 0;
        document.getElementById('lbl-slider-time').innerText = "Show All Times";
    }
}

function deleteCompareTrack(id) {
    state.compareTracks = state.compareTracks.filter(t => t.id !== id);
    renderCompareMode();
    showToast('Deleted track from comparison.', 'info');
}

function toggleCompareTrackVisibility(id) {
    const track = state.compareTracks.find(t => t.id === id);
    if (track) {
        track.visible = !track.visible;
        renderCompareMode();
    }
}

function updateCompareTimeFilter(val) {
    const label = document.getElementById('lbl-slider-time');
    if (!label) return;
    
    if (val === 0 || !state.compareHalfHours || state.compareHalfHours.length === 0) {
        // Show All Times
        label.innerText = "Show All Times";
        
        state.drawings.compareNodesGroup.eachLayer(layer => {
            layer.setOpacity(1.0);
            layer.getElement()?.classList.remove('highlighted');
        });
        
        state.drawings.compareLinesGroup.eachLayer(layer => {
            layer.setStyle({ opacity: 0.75, weight: 1.5 });
        });
        return;
    }
    
    const targetTime = state.compareHalfHours[val - 1];
    const offset = getLocalOffsetHours();
    const utcSec = (targetTime - offset * 3600 + 86400 * 2) % 86400;
    label.innerText = `Time: ${formatTimeStr(targetTime)} Local (${formatTimeStr(utcSec)} UTC)`;
    
    state.drawings.compareNodesGroup.eachLayer(layer => {
        if (layer.compareTime === targetTime) {
            layer.setOpacity(1.0);
            layer.getElement()?.classList.add('highlighted');
        } else {
            layer.setOpacity(0.12);
            layer.getElement()?.classList.remove('highlighted');
        }
    });
    
    state.drawings.compareLinesGroup.eachLayer(layer => {
        if (layer.compareTime === targetTime) {
            layer.setStyle({ opacity: 0.95, weight: 3 });
        } else {
            layer.setStyle({ opacity: 0.05, weight: 1.0 });
        }
    });
}
