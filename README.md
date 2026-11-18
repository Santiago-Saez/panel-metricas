# Panel de métricas — SVG puro

Panel con 4 gráficos en **SVG puro, sin librerías**: líneas, barras apiladas, dispersión y mapa de calor.

## Requisitos cubiertos

- **Escalas lineales y temporales calculadas a mano**, con ticks "bonitos" (Wilkinson simplificado, explicado en el comentario de cabecera de `app.js`).
- **Tooltip al pasar el ratón que encuentra el punto más cercano** (búsqueda del mínimo `dx²+dy²` en píxeles, sin Voronoi externo).
- **Responsive de verdad**: se mide `clientWidth` con `ResizeObserver` y se redibuja con `width/height` nuevos, con `font-size` constante. No se usa `viewBox` escalado, así el texto no se deforma.
- **Legible en tema claro y oscuro, con contraste AA** en textos (ver `styles.css`).
- **Datos de ejemplo en un JSON aparte** (`data.json`).

## Estructura

```text
index.html  # layout, 4 tarjetas, tooltip, footer
styles.css  # temas claro/oscuro, contraste AA, grid responsive
app.js      # escalas, ticks, 4 renders, tooltip, ResizeObserver (sin deps)
data.json   # datos de ejemplo
```

## Uso

Hay que servir por HTTP (el `fetch("data.json")` falla con `file://`):

```bash
python3 -m http.server 8000
# abrir http://localhost:8000
```

## Datos (`data.json`)

```json
{
  "linea": { "series": [{ "id": "visitas", "etiqueta": "...", "valores": [{ "fecha": "2026-10-19", "valor": 1313 }] }] },
  "barrasApiladas": { "categorias": ["Jun", ...], "series": [{ "etiqueta": "Orgánico", "valores": [...] }] },
  "dispersion": { "puntos": [{ "x": 533.0, "y": 40.8, "grupo": "A - Search", "etiqueta": "Campaña 01" }], "xEtiqueta": "...", "yEtiqueta": "..." },
  "mapaCalor": { "xEtiquetas": ["00h", ...], "yEtiquetas": ["Lun", ...], "valores": [[6.9, ...]], "xNombre": "...", "yNombre": "..." }
}
```

Para usar datos propios basta mantener esa forma y recargar.

## Cómo funciona (`app.js`)

- `linearScale(d0,d1,r0,r1)` y `timeScale(t0,t1,r0,r1)` con `map` / `invert`.
- `niceLinearTicks(min,max,target)`: candidatos `Q = {1, 2, 2.5, 5, 10} × 10^k`, coste = cercanía al paso bruto − bonificación por simplicidad; dominio anclado a múltiplos del paso.
- `niceTimeTicks(min,max,target)`: elige intervalo (12h, 1d, 2d, 1w, …, meses) más cercano al objetivo y redondea a frontera de calendario (medianoche, lunes, día 1).
- `bandScale` manual para barras apiladas.
- `nearest(px,py,list)`: tooltip con el punto/celda/segmento más cercano + anillo `.hover-ring`.
- `renderAll()` + `ResizeObserver` con `requestAnimationFrame` (`queueRender`).
- `palette()` cambia colores según `effectiveTheme()`; el texto de ejes usa `currentColor` + `var(--muted)` para garantizar AA en ambos temas.

## Temas y accesibilidad

- Toggle 🌙/☀️ (`#theme-toggle`), guarda en `localStorage`, respeta `prefers-color-scheme` en `auto`.
- SVG con `role="img"` y `aria-label`; tooltip con `role="status"` y `aria-live="polite"`.
- Texto de ejes a 12px con color `--muted` (~7.5:1 en claro, ~12:1 en oscuro).
