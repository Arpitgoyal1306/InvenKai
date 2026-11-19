import { useEffect, useRef } from "react";

// Isometric pallet study. Drawing in model coordinates keeps labels and
// packing tape attached to the carton faces as the panel resizes.
export default function Warehouse() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    function draw() {
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const dpi = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = box.width * dpi;
      canvas.height = box.height * dpi;
      const c = canvas.getContext("2d");
      const scale = Math.min(box.width / 480, box.height / 340);
      c.scale(dpi, dpi);
      c.translate(box.width * 0.5, box.height * 0.53);
      c.scale(scale, scale);
      const point = ([x, y, z]) => [(x - y) * 0.91, (x + y) * 0.43 - z];
      function face(points, fill, line) {
        c.beginPath();
        points
          .map(point)
          .forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
        if (points.length > 2) c.closePath();
        if (fill) {
          c.fillStyle = fill;
          c.fill();
        }
        if (line) {
          c.strokeStyle = line;
          c.lineWidth = 0.8;
          c.stroke();
        }
      }
      function solid(x, y, z, w, d, h, palette) {
        face(
          [
            [x, y, z + h],
            [x + w, y, z + h],
            [x + w, y + d, z + h],
            [x, y + d, z + h],
          ],
          palette[0],
          palette[3],
        );
        face(
          [
            [x, y + d, z + h],
            [x + w, y + d, z + h],
            [x + w, y + d, z],
            [x, y + d, z],
          ],
          palette[1],
          palette[3],
        );
        face(
          [
            [x + w, y, z + h],
            [x + w, y + d, z + h],
            [x + w, y + d, z],
            [x + w, y, z],
          ],
          palette[2],
          palette[3],
        );
      }
      for (let n = -240; n < 240; n += 18) {
        face(
          [
            [n, -195, -60],
            [n, 195, -60],
          ],
          null,
          "#36514a",
        );
        face(
          [
            [-195, n, -60],
            [195, n, -60],
          ],
          null,
          "#36514a",
        );
      }
      const wood = ["#ad8a63", "#896848", "#664e38", "#423e30"];
      for (const y of [-76, -5, 66]) solid(-96, y, -59, 192, 13, 5, wood);
      for (const x of [-90, -6, 77])
        for (const y of [-74, -5, 65]) solid(x, y, -54, 15, 15, 11, wood);
      for (let y = -78; y < 80; y += 19) solid(-98, y, -43, 196, 15, 6, wood);
      const palettes = [
        ["#e9bb81", "#c68f57", "#a27245", "#815e3f"],
        ["#f6d3a3", "#dfae75", "#ba8d5b", "#896b4a"],
        ["#ff9857", "#e57a3f", "#b65c33", "#934e30"],
      ];
      function carton(x, y, z, w, d, h, color) {
        solid(x, y, z, w, d, h, palettes[color]);
        const m = x + w * 0.5,
          front = y + d;
        face(
          [
            [m - 4, y, z + h],
            [m + 4, y, z + h],
            [m + 4, front, z + h],
            [m - 4, front, z + h],
          ],
          "#f4ddb696",
        );
        face(
          [
            [m - 4, front, z + h],
            [m + 4, front, z + h],
            [m + 4, front, z + h - 10],
            [m - 4, front, z + h - 10],
          ],
          "#e5c89a",
        );
        const a = x + 5,
          b = z + 5;
        face(
          [
            [a, front, b],
            [a + 17, front, b],
            [a + 17, front, b + 12],
            [a, front, b + 12],
          ],
          "#eeead7",
        );
        for (const i of [2, 4, 5, 8, 10, 13, 14])
          face(
            [
              [a + i, front, b + 3],
              [a + i, front, b + 9],
            ],
            null,
            "#544e40",
          );
        for (const i of [8, 13])
          face(
            [
              [x + w, y + i, z + 7],
              [x + w, y + i, z + 15],
            ],
            null,
            "#614c35",
          );
      }
      for (let level = 0; level < 3; level++) {
        for (let j = 0; j < 2; j++)
          for (let i = 0; i < 3; i++) {
            if (level === 2 && (i === 2 || (i === 1 && j === 1))) continue;
            if (level === 1 && i === 2 && j === 1) continue;
            carton(
              -90 + i * 61,
              -71 + j * 72,
              -37 + level * 44,
              58,
              69,
              43,
              (i + j + level) % 3 === 0 ? 2 : (i + level) % 2,
            );
          }
      }
    }
    const observer = new ResizeObserver(draw);
    observer.observe(ref.current);
    draw();
    return () => observer.disconnect();
  }, []);
  return (
    <canvas
      ref={ref}
      className="warehouse"
      role="img"
      aria-label="Isometric illustration of labeled cartons stacked on a warehouse pallet"
    />
  );
}
