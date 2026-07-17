(() => {
  "use strict";

  const MAX_MODELS = 200;
  const TILE_MIN_WIDTH = 208;
  const TILE_HEIGHT = 228;
  const MOBILE_TILE_MIN_WIDTH = 160;
  const MOBILE_TILE_HEIGHT = 190;
  const CAMERA_DEFAULT = Object.freeze({ yaw: -0.72, pitch: -0.48, panX: 0, panY: 0, distance: 3.25 });

  const elements = {
    canvas: document.getElementById("glCanvas"),
    viewerShell: document.getElementById("viewerShell"),
    viewerStage: document.getElementById("viewerStage"),
    tileOverlay: document.getElementById("tileOverlay"),
    emptyState: document.getElementById("emptyState"),
    folderInput: document.getElementById("folderInput"),
    folderSummary: document.getElementById("folderSummary"),
    quantity: document.getElementById("quantity"),
    quantityValue: document.getElementById("quantityValue"),
    status: document.getElementById("statusMessage"),
    wireToggle: document.getElementById("wireToggle"),
    fitMode: document.getElementById("fitMode"),
    resetView: document.getElementById("resetView")
  };

  const state = {
    files: [],
    models: [],
    pending: new Map(),
    visibleCount: Number(elements.quantity.value),
    selectedIndex: -1,
    generation: 0,
    loadedCount: 0,
    failedCount: 0,
    totalTriangles: 0,
    commonRadius: 0,
    columns: 1,
    tileWidth: TILE_MIN_WIDTH,
    tileHeight: TILE_HEIGHT,
    dragging: null,
    renderRequested: false,
    wireframe: false,
    fitMode: "individual",
    camera: { ...CAMERA_DEFAULT }
  };

  const gl = elements.canvas.getContext("webgl2", {
    antialias: true,
    alpha: false,
    depth: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false
  });

  if (!gl) {
    setStatus("WebGL2を利用できません。ハードウェアアクセラレーションが有効なChromium系ブラウザで開いてください。", "error");
    elements.folderInput.disabled = true;
    return;
  }

  const renderer = createRenderer(gl);
  let parserPool = createParserPool(Math.min(4, Math.max(2, navigator.hardwareConcurrency || 4)));
  const resizeObserver = new ResizeObserver(() => {
    updateLayout();
    requestRender();
  });
  resizeObserver.observe(elements.viewerShell);

  elements.folderInput.addEventListener("change", () => {
    if (elements.folderInput.files?.length) loadFolder(elements.folderInput.files);
  });

  elements.quantity.addEventListener("input", () => {
    const requested = Number(elements.quantity.value);
    state.visibleCount = state.files.length ? Math.min(requested, state.files.length) : requested;
    updateQuantityOutput();
    rebuildTiles();
    updateLayout();
    ensureVisibleModelsLoaded();
    requestRender();
  });

  elements.wireToggle.addEventListener("click", () => {
    state.wireframe = !state.wireframe;
    elements.wireToggle.setAttribute("aria-pressed", String(state.wireframe));
    requestRender();
  });

  elements.fitMode.addEventListener("change", () => {
    state.fitMode = elements.fitMode.value;
    requestRender();
  });

  elements.resetView.addEventListener("click", () => setCamera(CAMERA_DEFAULT));

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const views = {
        iso: { yaw: -0.72, pitch: -0.48 },
        front: { yaw: 0, pitch: 0 },
        right: { yaw: -Math.PI / 2, pitch: 0 },
        top: { yaw: 0, pitch: -Math.PI / 2 },
        back: { yaw: Math.PI, pitch: 0 }
      };
      setCamera({ ...state.camera, ...views[button.dataset.view], panX: 0, panY: 0 });
    });
  });

  elements.canvas.addEventListener("pointerdown", onPointerDown);
  elements.canvas.addEventListener("pointermove", onPointerMove);
  elements.canvas.addEventListener("pointerup", onPointerUp);
  elements.canvas.addEventListener("pointercancel", onPointerUp);
  elements.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  elements.canvas.addEventListener("wheel", onWheel, { passive: false });
  elements.canvas.addEventListener("keydown", onKeyDown);
  elements.viewerShell.addEventListener("scroll", requestRender, { passive: true });

  ["dragenter", "dragover"].forEach((type) => {
    elements.viewerShell.addEventListener(type, (event) => {
      event.preventDefault();
      elements.viewerShell.classList.add("drop-active");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    elements.viewerShell.addEventListener(type, (event) => {
      event.preventDefault();
      if (type === "drop") {
        const files = event.dataTransfer?.files;
        if (files?.length) loadFolder(files);
      }
      elements.viewerShell.classList.remove("drop-active");
    });
  });

  window.addEventListener("beforeunload", () => parserPool.destroy());

  updateQuantityOutput();
  updateLayout();
  requestRender();

  function loadFolder(fileList) {
    const files = Array.from(fileList)
      .filter((file) => file.name.toLowerCase().endsWith(".stl"))
      .sort((a, b) => naturalCompare(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name))
      .slice(0, MAX_MODELS);

    if (!files.length) {
      setStatus("選択したフォルダーにSTLファイルが見つかりませんでした。", "error");
      elements.folderInput.value = "";
      return;
    }

    clearModels();
    state.generation += 1;
    parserPool.destroy();
    parserPool = createParserPool(Math.min(4, Math.max(2, navigator.hardwareConcurrency || 4)));
    state.files = files;
    state.models = new Array(files.length).fill(null);
    state.visibleCount = Math.min(Number(elements.quantity.value), files.length);
    state.selectedIndex = -1;
    elements.folderInput.value = "";

    const firstPath = files[0].webkitRelativePath || files[0].name;
    const folderName = firstPath.includes("/") ? firstPath.split("/")[0] : "選択済みファイル";
    const clipped = fileList.length > MAX_MODELS ? `（先頭${MAX_MODELS}件）` : "";
    elements.folderSummary.textContent = `${folderName} · STL ${files.length}件${clipped}`;
    elements.quantity.max = String(Math.min(MAX_MODELS, files.length));
    elements.quantity.value = String(state.visibleCount);
    elements.emptyState.hidden = true;

    updateQuantityOutput();
    rebuildTiles();
    updateLayout();
    ensureVisibleModelsLoaded();
    requestRender();
  }

  function clearModels() {
    state.models.forEach((model) => {
      if (model?.gpu) renderer.disposeMesh(model.gpu);
    });
    state.pending.clear();
    state.models = [];
    state.files = [];
    state.loadedCount = 0;
    state.failedCount = 0;
    state.totalTriangles = 0;
    state.commonRadius = 0;
  }

  function ensureVisibleModelsLoaded() {
    if (!state.files.length) return;
    const generation = state.generation;
    const target = Math.min(state.visibleCount, state.files.length);

    for (let index = 0; index < target; index += 1) {
      if (state.models[index] || state.pending.has(index)) continue;
      const file = state.files[index];
      setTileState(index, "解析中…");

      const pending = parserPool.run(file)
        .then((parsed) => {
          if (generation !== state.generation) return;
          const gpu = renderer.createMesh(parsed.vertices, parsed.edgeIndices);
          const radius = Math.max(parsed.radius, 1e-7);
          state.models[index] = {
            gpu,
            name: file.name,
            triangleCount: parsed.triangleCount,
            center: parsed.center,
            radius
          };
          state.loadedCount += 1;
          state.totalTriangles += parsed.triangleCount;
          state.commonRadius = Math.max(state.commonRadius, radius);
          setTileLoaded(index, parsed.triangleCount);
          updateStatus();
          requestRender();
        })
        .catch((error) => {
          if (generation !== state.generation) return;
          state.models[index] = { error: error?.message || "解析できませんでした" };
          state.failedCount += 1;
          setTileState(index, "読込エラー", true);
          updateStatus();
        })
        .finally(() => {
          state.pending.delete(index);
          if (generation === state.generation) updateStatus();
        });

      state.pending.set(index, pending);
    }
    updateStatus();
  }

  function rebuildTiles() {
    const count = state.files.length ? Math.min(state.visibleCount, state.files.length) : 0;
    const fragment = document.createDocumentFragment();
    elements.tileOverlay.textContent = "";

    for (let index = 0; index < count; index += 1) {
      const file = state.files[index];
      const model = state.models[index];
      const card = document.createElement("div");
      card.className = `tile-card${state.selectedIndex === index ? " selected" : ""}`;
      card.dataset.index = String(index);

      const head = document.createElement("div");
      head.className = "tile-head";
      const number = document.createElement("span");
      number.className = "tile-index";
      number.textContent = String(index + 1).padStart(2, "0");
      const name = document.createElement("span");
      name.className = "tile-name";
      name.textContent = file.name;
      name.title = file.webkitRelativePath || file.name;
      head.append(number, name);
      card.append(head);

      if (model?.gpu) {
        const meta = document.createElement("span");
        meta.className = "tile-meta";
        meta.textContent = `${formatNumber(model.triangleCount)} tri`;
        card.append(meta);
      } else {
        const loading = document.createElement("span");
        loading.className = `tile-state${model?.error ? " error" : ""}`;
        loading.textContent = model?.error ? "読込エラー" : "待機中";
        card.append(loading);
      }
      fragment.append(card);
    }
    elements.tileOverlay.append(fragment);
  }

  function setTileState(index, message, isError = false) {
    const card = elements.tileOverlay.querySelector(`[data-index="${index}"]`);
    if (!card) return;
    let label = card.querySelector(".tile-state");
    if (!label) {
      label = document.createElement("span");
      card.append(label);
    }
    label.className = `tile-state${isError ? " error" : ""}`;
    label.textContent = message;
  }

  function setTileLoaded(index, triangleCount) {
    const card = elements.tileOverlay.querySelector(`[data-index="${index}"]`);
    if (!card) return;
    card.querySelector(".tile-state")?.remove();
    let meta = card.querySelector(".tile-meta");
    if (!meta) {
      meta = document.createElement("span");
      meta.className = "tile-meta";
      card.append(meta);
    }
    meta.textContent = `${formatNumber(triangleCount)} tri`;
  }

  function updateLayout() {
    const width = Math.max(1, elements.viewerShell.clientWidth);
    const compact = width <= 560;
    const minWidth = compact ? MOBILE_TILE_MIN_WIDTH : TILE_MIN_WIDTH;
    state.tileHeight = compact ? MOBILE_TILE_HEIGHT : TILE_HEIGHT;
    state.columns = Math.max(1, Math.floor(width / minWidth));
    state.tileWidth = width / state.columns;

    const count = state.files.length ? Math.min(state.visibleCount, state.files.length) : 0;
    const rows = Math.max(1, Math.ceil(count / state.columns));
    const viewportHeight = elements.viewerShell.clientHeight;
    const stageHeight = count ? Math.max(viewportHeight, rows * state.tileHeight) : viewportHeight;

    elements.viewerStage.style.height = `${stageHeight}px`;
    elements.canvas.style.height = `${Math.max(1, viewportHeight)}px`;
    elements.tileOverlay.style.height = `${stageHeight}px`;
    elements.tileOverlay.style.gridTemplateColumns = `repeat(${state.columns}, minmax(0, 1fr))`;
    elements.tileOverlay.style.gridAutoRows = `${state.tileHeight}px`;
  }

  function requestRender() {
    if (state.renderRequested) return;
    state.renderRequested = true;
    requestAnimationFrame(render);
  }

  function render() {
    state.renderRequested = false;
    const cssWidth = Math.max(1, elements.viewerStage.clientWidth);
    const cssHeight = Math.max(1, elements.viewerShell.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

    if (elements.canvas.width !== pixelWidth || elements.canvas.height !== pixelHeight) {
      elements.canvas.width = pixelWidth;
      elements.canvas.height = pixelHeight;
    }

    renderer.beginFrame(pixelWidth, pixelHeight);
    const count = state.files.length ? Math.min(state.visibleCount, state.files.length) : 0;
    const scrollTop = elements.viewerShell.scrollTop;
    const visibleTop = scrollTop - state.tileHeight;
    const visibleBottom = scrollTop + elements.viewerShell.clientHeight + state.tileHeight;
    const visibleCommonRadius = state.models.slice(0, count).reduce(
      (largest, model) => model?.gpu ? Math.max(largest, model.radius) : largest,
      1e-7
    );

    for (let index = 0; index < count; index += 1) {
      const row = Math.floor(index / state.columns);
      const col = index % state.columns;
      const yTop = row * state.tileHeight;
      if (yTop + state.tileHeight < visibleTop || yTop > visibleBottom) continue;
      const model = state.models[index];
      if (!model?.gpu) continue;

      const x = Math.round(col * state.tileWidth * dpr);
      const yInViewport = yTop - scrollTop;
      const y = pixelHeight - Math.round((yInViewport + state.tileHeight) * dpr);
      const width = Math.round(state.tileWidth * dpr);
      const height = Math.round(state.tileHeight * dpr);
      const scaleRadius = state.fitMode === "common" ? visibleCommonRadius : model.radius;
      renderer.drawMesh(model, { x, y, width, height }, state.camera, scaleRadius, state.wireframe);
    }
  }

  function onPointerDown(event) {
    if (event.button !== 0 && event.button !== 2) return;
    elements.canvas.setPointerCapture(event.pointerId);
    elements.canvas.classList.add("dragging");
    state.dragging = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      mode: event.shiftKey || event.button === 2 ? "pan" : "rotate"
    };
  }

  function onPointerMove(event) {
    const drag = state.dragging;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;

    if (drag.mode === "pan" || event.shiftKey) {
      const factor = 0.0042 * state.camera.distance;
      state.camera.panX += dx * factor;
      state.camera.panY -= dy * factor;
    } else {
      state.camera.yaw += dx * 0.009;
      state.camera.pitch = clamp(state.camera.pitch + dy * 0.009, -Math.PI / 2, Math.PI / 2);
    }
    requestRender();
  }

  function onPointerUp(event) {
    const drag = state.dragging;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (moved < 4 && event.button !== 2) selectTileAt(event.clientX, event.clientY);
    state.dragging = null;
    elements.canvas.classList.remove("dragging");
    if (elements.canvas.hasPointerCapture(event.pointerId)) elements.canvas.releasePointerCapture(event.pointerId);
  }

  function selectTileAt(clientX, clientY) {
    const rect = elements.canvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top + elements.viewerShell.scrollTop;
    const col = Math.floor(localX / state.tileWidth);
    const row = Math.floor(localY / state.tileHeight);
    const index = row * state.columns + col;
    const count = state.files.length ? Math.min(state.visibleCount, state.files.length) : 0;
    if (index < 0 || index >= count) return;

    state.selectedIndex = state.selectedIndex === index ? -1 : index;
    elements.tileOverlay.querySelectorAll(".tile-card.selected").forEach((card) => card.classList.remove("selected"));
    if (state.selectedIndex >= 0) {
      elements.tileOverlay.querySelector(`[data-index="${state.selectedIndex}"]`)?.classList.add("selected");
    }
  }

  function onWheel(event) {
    event.preventDefault();
    const zoom = Math.exp(event.deltaY * 0.00125);
    state.camera.distance = clamp(state.camera.distance * zoom, 1.35, 12);
    requestRender();
  }

  function onKeyDown(event) {
    const step = event.shiftKey ? 0.16 : 0.08;
    if (event.key === "ArrowLeft") state.camera.yaw -= step;
    else if (event.key === "ArrowRight") state.camera.yaw += step;
    else if (event.key === "ArrowUp") state.camera.pitch = clamp(state.camera.pitch - step, -Math.PI / 2, Math.PI / 2);
    else if (event.key === "ArrowDown") state.camera.pitch = clamp(state.camera.pitch + step, -Math.PI / 2, Math.PI / 2);
    else if (event.key === "+" || event.key === "=") state.camera.distance = clamp(state.camera.distance * 0.88, 1.35, 12);
    else if (event.key === "-" || event.key === "_") state.camera.distance = clamp(state.camera.distance * 1.14, 1.35, 12);
    else if (event.key === "0") setCamera(CAMERA_DEFAULT);
    else return;
    event.preventDefault();
    requestRender();
  }

  function setCamera(values) {
    Object.assign(state.camera, values);
    requestRender();
  }

  function updateQuantityOutput() {
    elements.quantityValue.innerHTML = `${state.visibleCount}<small>件</small>`;
  }

  function updateStatus() {
    const target = Math.min(state.visibleCount, state.files.length);
    const activeLoaded = state.models.slice(0, target).filter((model) => model?.gpu).length;
    const activePending = Array.from(state.pending.keys()).filter((index) => index < target).length;
    const parts = [`表示 ${target}件`, `読込 ${activeLoaded}/${target}`];
    const activeTriangles = state.models.slice(0, target).reduce(
      (sum, model) => model?.gpu ? sum + model.triangleCount : sum,
      0
    );
    if (activeTriangles) parts.push(`合計 ${formatNumber(activeTriangles)} triangles`);
    if (activePending) parts.push(`解析中 ${activePending}件`);
    if (state.failedCount) parts.push(`エラー ${state.failedCount}件`);
    setStatus(parts.join(" · "), state.failedCount ? "warning" : "normal");
  }

  function setStatus(message, level = "normal") {
    elements.status.textContent = message;
    elements.status.style.color = level === "error" ? "var(--danger)" : level === "warning" ? "var(--warning)" : "";
  }

  function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("ja-JP").format(value);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function createParserPool(size) {
    const source = `
      self.onmessage = (event) => {
        const { id, buffer, name } = event.data;
        try {
          const result = parseSTL(buffer);
          self.postMessage({ id, result }, [result.vertices.buffer, result.edgeIndices.buffer]);
        } catch (error) {
          self.postMessage({ id, error: error && error.message ? error.message : name + " を解析できませんでした" });
        }
      };

      function parseSTL(buffer) {
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 15) throw new Error("STLデータが空か短すぎます");
        const view = new DataView(buffer);
        let binary = false;
        let count = 0;
        if (buffer.byteLength >= 84) {
          count = view.getUint32(80, true);
          const expected = 84 + count * 50;
          binary = count > 0 && expected <= buffer.byteLength && buffer.byteLength - expected < 1024;
        }
        return binary ? parseBinary(view, count) : parseASCII(buffer);
      }

      function parseBinary(view, triangleCount) {
        if (!triangleCount || triangleCount > 10000000) throw new Error("三角形数が不正です");
        const vertices = new Float32Array(triangleCount * 18);
        const edges = new Uint32Array(triangleCount * 6);
        const bounds = createBounds();
        let input = 84;
        let output = 0;
        for (let tri = 0; tri < triangleCount; tri += 1, input += 50) {
          const ax = view.getFloat32(input + 12, true), ay = view.getFloat32(input + 16, true), az = view.getFloat32(input + 20, true);
          const bx = view.getFloat32(input + 24, true), by = view.getFloat32(input + 28, true), bz = view.getFloat32(input + 32, true);
          const cx = view.getFloat32(input + 36, true), cy = view.getFloat32(input + 40, true), cz = view.getFloat32(input + 44, true);
          output = writeTriangle(vertices, output, ax, ay, az, bx, by, bz, cx, cy, cz, bounds);
          writeEdges(edges, tri);
        }
        return finish(vertices, edges, triangleCount, bounds);
      }

      function parseASCII(buffer) {
        const text = new TextDecoder().decode(buffer);
        const positions = [];
        const vertexPattern = /\\bvertex\\s+([^\\s]+)\\s+([^\\s]+)\\s+([^\\s]+)/gi;
        let match;
        while ((match = vertexPattern.exec(text))) {
          const x = Number.parseFloat(match[1]);
          const y = Number.parseFloat(match[2]);
          const z = Number.parseFloat(match[3]);
          if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) positions.push(x, y, z);
        }
        const triangleCount = Math.floor(positions.length / 9);
        if (!triangleCount) throw new Error("ASCII STLに頂点が見つかりません");
        const vertices = new Float32Array(triangleCount * 18);
        const edges = new Uint32Array(triangleCount * 6);
        const bounds = createBounds();
        let output = 0;
        for (let tri = 0; tri < triangleCount; tri += 1) {
          const p = tri * 9;
          output = writeTriangle(vertices, output,
            positions[p], positions[p + 1], positions[p + 2],
            positions[p + 3], positions[p + 4], positions[p + 5],
            positions[p + 6], positions[p + 7], positions[p + 8], bounds);
          writeEdges(edges, tri);
        }
        return finish(vertices, edges, triangleCount, bounds);
      }

      function createBounds() {
        return { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
      }

      function writeTriangle(out, offset, ax, ay, az, bx, by, bz, cx, cy, cz, bounds) {
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz) || 1;
        nx /= length; ny /= length; nz /= length;
        const values = [ax, ay, az, bx, by, bz, cx, cy, cz];
        for (let i = 0; i < 9; i += 3) {
          const x = values[i], y = values[i + 1], z = values[i + 2];
          out[offset++] = x; out[offset++] = y; out[offset++] = z;
          out[offset++] = nx; out[offset++] = ny; out[offset++] = nz;
          if (x < bounds.minX) bounds.minX = x; if (x > bounds.maxX) bounds.maxX = x;
          if (y < bounds.minY) bounds.minY = y; if (y > bounds.maxY) bounds.maxY = y;
          if (z < bounds.minZ) bounds.minZ = z; if (z > bounds.maxZ) bounds.maxZ = z;
        }
        return offset;
      }

      function writeEdges(edges, tri) {
        const vertex = tri * 3;
        const offset = tri * 6;
        edges[offset] = vertex; edges[offset + 1] = vertex + 1;
        edges[offset + 2] = vertex + 1; edges[offset + 3] = vertex + 2;
        edges[offset + 4] = vertex + 2; edges[offset + 5] = vertex;
      }

      function finish(vertices, edgeIndices, triangleCount, bounds) {
        const center = [
          (bounds.minX + bounds.maxX) / 2,
          (bounds.minY + bounds.maxY) / 2,
          (bounds.minZ + bounds.maxZ) / 2
        ];
        const radius = Math.max(
          bounds.maxX - bounds.minX,
          bounds.maxY - bounds.minY,
          bounds.maxZ - bounds.minZ
        ) / 2;
        if (!Number.isFinite(radius)) throw new Error("頂点座標が不正です");
        return { vertices, edgeIndices, triangleCount, center, radius };
      }
    `;

    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const workers = [];
    const queue = [];
    const jobs = new Map();
    let nextId = 1;
    let destroyed = false;

    for (let index = 0; index < size; index += 1) {
      const worker = new Worker(url);
      const slot = { worker, busy: false, jobId: null };
      worker.onmessage = (event) => finishJob(slot, event.data);
      worker.onerror = (event) => finishJob(slot, { id: slot.jobId, error: event.message || "解析ワーカーでエラーが発生しました" });
      workers.push(slot);
    }

    function run(file) {
      if (destroyed) return Promise.reject(new Error("解析処理は終了しています"));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        jobs.set(id, { id, file, resolve, reject });
        queue.push(id);
        dispatch();
      });
    }

    function dispatch() {
      if (destroyed) return;
      workers.forEach((slot) => {
        if (slot.busy || !queue.length) return;
        const id = queue.shift();
        const job = jobs.get(id);
        if (!job) return;
        slot.busy = true;
        slot.jobId = id;
        job.file.arrayBuffer()
          .then((buffer) => {
            if (destroyed || !jobs.has(id)) return;
            slot.worker.postMessage({ id, buffer, name: job.file.name }, [buffer]);
          })
          .catch((error) => finishJob(slot, { id, error: error?.message || "ファイルを読み取れませんでした" }));
      });
    }

    function finishJob(slot, message) {
      const job = jobs.get(message.id);
      if (job) {
        jobs.delete(message.id);
        if (message.error) job.reject(new Error(message.error));
        else job.resolve(message.result);
      }
      slot.busy = false;
      slot.jobId = null;
      dispatch();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      workers.forEach((slot) => slot.worker.terminate());
      jobs.forEach((job) => job.reject(new Error("新しいフォルダーが選択されました")));
      jobs.clear();
      queue.length = 0;
      URL.revokeObjectURL(url);
    }

    return { run, destroy };
  }

  function createRenderer(context) {
    const vertexSource = `#version 300 es
      precision highp float;
      layout(location = 0) in vec3 aPosition;
      layout(location = 1) in vec3 aNormal;
      uniform mat4 uModelView;
      uniform mat4 uProjection;
      out vec3 vNormal;
      out vec3 vPosition;
      void main() {
        vec4 position = uModelView * vec4(aPosition, 1.0);
        vPosition = position.xyz;
        vNormal = normalize(mat3(uModelView) * aNormal);
        gl_Position = uProjection * position;
      }
    `;
    const fragmentSource = `#version 300 es
      precision highp float;
      in vec3 vNormal;
      in vec3 vPosition;
      uniform vec3 uBaseColor;
      out vec4 outColor;
      void main() {
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 lightA = normalize(vec3(0.45, 0.75, 0.65));
        vec3 lightB = normalize(vec3(-0.7, -0.15, 0.35));
        float diffuse = max(dot(n, lightA), 0.0);
        float fill = max(dot(n, lightB), 0.0) * 0.28;
        vec3 viewDir = normalize(-vPosition);
        vec3 halfDir = normalize(lightA + viewDir);
        float specular = pow(max(dot(n, halfDir), 0.0), 42.0) * 0.34;
        float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.4) * 0.18;
        vec3 color = uBaseColor * (0.22 + diffuse * 0.66 + fill) + vec3(specular + rim);
        outColor = vec4(pow(color, vec3(0.92)), 1.0);
      }
    `;
    const lineVertexSource = `#version 300 es
      precision highp float;
      layout(location = 0) in vec3 aPosition;
      uniform mat4 uModelView;
      uniform mat4 uProjection;
      void main() { gl_Position = uProjection * uModelView * vec4(aPosition, 1.0); }
    `;
    const lineFragmentSource = `#version 300 es
      precision highp float;
      out vec4 outColor;
      void main() { outColor = vec4(0.0, 0.243, 0.569, 1.0); }
    `;

    const solidProgram = linkProgram(context, vertexSource, fragmentSource);
    const lineProgram = linkProgram(context, lineVertexSource, lineFragmentSource);
    const solidUniforms = getUniforms(context, solidProgram, ["uModelView", "uProjection", "uBaseColor"]);
    const lineUniforms = getUniforms(context, lineProgram, ["uModelView", "uProjection"]);

    context.enable(context.DEPTH_TEST);
    context.depthFunc(context.LEQUAL);
      context.disable(context.CULL_FACE);

    function createMesh(vertices, edgeIndices) {
      const vao = context.createVertexArray();
      const vertexBuffer = context.createBuffer();
      const edgeBuffer = context.createBuffer();
      context.bindVertexArray(vao);
      context.bindBuffer(context.ARRAY_BUFFER, vertexBuffer);
      context.bufferData(context.ARRAY_BUFFER, vertices, context.STATIC_DRAW);
      context.enableVertexAttribArray(0);
      context.vertexAttribPointer(0, 3, context.FLOAT, false, 24, 0);
      context.enableVertexAttribArray(1);
      context.vertexAttribPointer(1, 3, context.FLOAT, false, 24, 12);
      context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, edgeBuffer);
      context.bufferData(context.ELEMENT_ARRAY_BUFFER, edgeIndices, context.STATIC_DRAW);
      context.bindVertexArray(null);
      return { vao, vertexBuffer, edgeBuffer, vertexCount: vertices.length / 6, edgeCount: edgeIndices.length };
    }

    function disposeMesh(mesh) {
      context.deleteVertexArray(mesh.vao);
      context.deleteBuffer(mesh.vertexBuffer);
      context.deleteBuffer(mesh.edgeBuffer);
    }

    function beginFrame(width, height) {
      context.disable(context.SCISSOR_TEST);
      context.viewport(0, 0, width, height);
      context.clearColor(0.914, 0.937, 0.973, 1);
      context.clear(context.COLOR_BUFFER_BIT | context.DEPTH_BUFFER_BIT);
      context.enable(context.SCISSOR_TEST);
    }

    function drawMesh(model, viewport, camera, scaleRadius, wireframe) {
      if (viewport.y + viewport.height < 0 || viewport.y > context.drawingBufferHeight) return;
      const clipX = Math.max(0, viewport.x);
      const clipY = Math.max(0, viewport.y);
      const clipRight = Math.min(context.drawingBufferWidth, viewport.x + viewport.width);
      const clipTop = Math.min(context.drawingBufferHeight, viewport.y + viewport.height);
      if (clipRight <= clipX || clipTop <= clipY) return;

      context.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      context.scissor(clipX, clipY, clipRight - clipX, clipTop - clipY);
      context.clearColor(0.894, 0.918, 0.973, 1);
      context.clear(context.COLOR_BUFFER_BIT | context.DEPTH_BUFFER_BIT);

      const aspect = viewport.width / Math.max(1, viewport.height);
      const projection = perspective(Math.PI / 4, aspect, 0.02, 100);
      const modelView = composeModelView(camera, model.center, 0.92 / Math.max(scaleRadius, 1e-7));

      context.useProgram(solidProgram);
      context.uniformMatrix4fv(solidUniforms.uModelView, false, modelView);
      context.uniformMatrix4fv(solidUniforms.uProjection, false, projection);
      context.uniform3f(solidUniforms.uBaseColor, 0.0, 0.333, 0.604);
      context.bindVertexArray(model.gpu.vao);
      context.enable(context.POLYGON_OFFSET_FILL);
      context.polygonOffset(1, 1);
      context.drawArrays(context.TRIANGLES, 0, model.gpu.vertexCount);
      context.disable(context.POLYGON_OFFSET_FILL);

      if (wireframe) {
        context.useProgram(lineProgram);
        context.uniformMatrix4fv(lineUniforms.uModelView, false, modelView);
        context.uniformMatrix4fv(lineUniforms.uProjection, false, projection);
        context.drawElements(context.LINES, model.gpu.edgeCount, context.UNSIGNED_INT, 0);
      }
      context.bindVertexArray(null);
    }

    return { createMesh, disposeMesh, beginFrame, drawMesh };
  }

  function getUniforms(context, program, names) {
    return Object.fromEntries(names.map((name) => [name, context.getUniformLocation(program, name)]));
  }

  function compileShader(context, type, source) {
    const shader = context.createShader(type);
    context.shaderSource(shader, source);
    context.compileShader(shader);
    if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
      const message = context.getShaderInfoLog(shader);
      context.deleteShader(shader);
      throw new Error(`WebGL shader error: ${message}`);
    }
    return shader;
  }

  function linkProgram(context, vertexSource, fragmentSource) {
    const vertex = compileShader(context, context.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(context, context.FRAGMENT_SHADER, fragmentSource);
    const program = context.createProgram();
    context.attachShader(program, vertex);
    context.attachShader(program, fragment);
    context.linkProgram(program);
    context.deleteShader(vertex);
    context.deleteShader(fragment);
    if (!context.getProgramParameter(program, context.LINK_STATUS)) {
      const message = context.getProgramInfoLog(program);
      context.deleteProgram(program);
      throw new Error(`WebGL program error: ${message}`);
    }
    return program;
  }

  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0
    ]);
  }

  function composeModelView(camera, center, scale) {
    let matrix = identity();
    matrix = multiply(matrix, translation(camera.panX, camera.panY, -camera.distance));
    matrix = multiply(matrix, rotationX(camera.pitch));
    matrix = multiply(matrix, rotationY(camera.yaw));
    matrix = multiply(matrix, scaling(scale, scale, scale));
    matrix = multiply(matrix, translation(-center[0], -center[1], -center[2]));
    return matrix;
  }

  function identity() {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }

  function translation(x, y, z) {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  }

  function scaling(x, y, z) {
    return new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
  }

  function rotationX(angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
  }

  function rotationY(angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
  }

  function multiply(a, b) {
    const out = new Float32Array(16);
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        out[column * 4 + row] =
          a[row] * b[column * 4] +
          a[4 + row] * b[column * 4 + 1] +
          a[8 + row] * b[column * 4 + 2] +
          a[12 + row] * b[column * 4 + 3];
      }
    }
    return out;
  }
})();
