# Game arena verification — 9 October 2026

Arena-only follow-up; existing multiplayer changes are preserved.

- Image Formation: separate board/tray/actions/history regions, compact mobile layout; tile placement verified in the browser.
- Detective: locked hints hide their content, confirmation shows the configured penalty, unlocking reveals the hint and deducts once. De-duplicate hint acknowledgements when SSE arrives before the request response. Disposable fixture score verified from 100 to 80 for a 20-point hint.
- Calculator: camera occupies a dedicated grid column, pause banner its own row; mobile legacy absolute positioning removed. Stable gesture voting reduced from five samples to three, publication gate from 400 to 100 ms, with confidence checks and inference cap retained.
- Memory: camera top right, detected gesture and countdown in the center, sequence separate. Long mobile instructions remain inside their card. Wrong guesses cannot submit early; corrected guesses may earn a point before expiry; timeout earns zero. Feedback cannot be overwritten during transition.

Validation: 75/75 automated tests; lint zero warnings/errors; backend/inline script syntax checks; Vite production build. Browser checks at 1280×800 and 390×844 using a disposable local replica set. No production records modified.

Physical camera recognition and real multi-device Internet latency were not measured. Camera-denied states were exercised. Changes are local and have not been deployed.
