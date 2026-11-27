# Dom 3D dla Home Assistant

Interaktywny model domu 3D w Home Assistant: rysujesz piętra, ściany, okna, drzwi i meble w panelu, przypinasz lampy i czujki do encji, a widok pokazuje dom na żywo - lampy świecą z prawdziwą jasnością i barwą, słońce pada przez okna zgodnie z `sun.sun`, otwarte okna i drzwi z kontaktronów są oznaczone, a ruch pulsuje.

Repozytorium zawiera **dodatek** (add-on) z panelem w menu bocznym HA i **kartę** `custom:dom3d-card` na dashboard (np. tablet na ścianie).

> Dane Twojego domu (plan, modele, encje) zostają w Home Assistant. Repo zawiera tylko kod aplikacji.

## Instalacja

1. **Ustawienia → Dodatki → Sklep z dodatkami → ⋮ → Repozytoria** i dodaj:
   `https://github.com/adamskomra-create/ha-dom3d`
2. Zainstaluj **Dom 3D** (budowa obrazu trwa kilka minut), uruchom i włącz **Pokaż na pasku bocznym**.
3. Otwórz **Dom 3D** z paska bocznego.

## Edytor (panel)

| Narzędzie | Skrót | Co robi |
|---|---|---|
| Podgląd | V | klik w lampę przełącza encję |
| Zaznacz / przesuń | S | klik zaznacza, przeciąganie przesuwa; R = obrót 90°, Del = usuń, Ctrl+D = duplikuj, strzałki = 1 cm (Shift 10 cm) |
| Ściana | W | klikaj narożniki; wpisz długość (np. `3.45`) + Enter; przyciąganie do końców ścian i kątów 45°; Shift = dowolny kąt; Esc = koniec |
| Pokój | P | przeciągnij prostokąt, potem nazwa, podłoga, obszar HA, czujnik temperatury i wilgotności |
| Okno / Drzwi / Przejście | O / D | kliknij na ścianę; wymiary, zawiasy i kontaktron po prawej |
| Schody | | przeciągnij prostokąt biegu |
| Mebel | M | wybierz rodzaj na pasku i kliknij; wymiary, model (IKEA/JYSK), link, opcjonalnie własny `.glb` |
| Lampa | L | kliknij; przypisz encję (`light.*`, `switch.*`), strumień w lm, barwę |
| Czujka | C | ruch, kontaktron, temperatura, dym, zalanie, gniazdko, kamera, głośnik… |
| Model .glb | | wstawia gotowy model (np. kuchnię z Blendera) |

Inne:
- Uchwyty na końcach zaznaczonej ściany przesuwają narożnik razem ze ścianami podpiętymi w tym samym punkcie (Ctrl = tylko ta ściana).
- **Podkład z rzutu** (panel po prawej, bez zaznaczenia): wgraj obraz rzutu i **Kalibruj (2 punkty)** podając rzeczywisty wymiar.
- Suwak ☀ pokazuje dom o dowolnej godzinie; „na żywo” bierze słońce z `sun.sun`.
- **Zapisz** (Ctrl+S) zapisuje projekt, robi kopię zapasową (50 ostatnich) i publikuje go dla karty.
- **Import / Eksport** - cały dom jako jeden plik `dom.json`.

## Karta na dashboard

1. Zapisz projekt w panelu - na dole panelu (bez zaznaczenia) zobaczysz adres danych.
2. **Ustawienia → Panele → ⋮ → Zasoby → Dodaj**: `/local/dom3d/dom3d-card.js?v=0.1.2`, typ **Moduł JavaScript**.
3. Dodaj kartę (YAML):

```yaml
type: custom:dom3d-card
data: /local/dom3d/<adres-z-panelu>/
floor: p1          # id albo nazwa piętra startowego
view: top          # top | 3d
height: 520px
quality: high      # low = bez cieni, dla słabszych tabletów
rotate: 0          # obrót planu na ekranie (°)
```

Kliknięcie lampy przełącza ją, kliknięcie czujki albo pokoju otwiera okno szczegółów encji.

> Dane karty leżą w `/config/www/dom3d/<losowy-adres>/` i są dostępne pod `/local/...` jak każdy plik w `www` - bez logowania, ale pod losowym, trudnym do zgadnięcia adresem.

## Blender

Blender służy do fotorealistycznych renderów i szczegółowych modeli (np. kuchnia). Skrypt `tools/blender/dom3d_export.py` eksportuje scenę do `.glb` bez ścian, podłóg, okien, kamer i świateł - te buduje aplikacja. Plik wgrywasz narzędziem **Model .glb** i ustawiasz pozycję/obrót po prawej.

## Format danych

`dom.json`: `floors`, `walls` (z `openings`), `rooms` (`poly`), `items`, `lights`, `sensors`, `models`, `stairs`, `backgrounds`. Jednostki: metry, kąty w stopniach, plan: x w prawo, y w górę rzutu. Przykład: `examples/demo.json`.

## Rozwój

```bash
npm install
npm run build                      # frontend -> dom3d/app/www
cd dom3d/app && DOM3D_DEV=1 python3 server.py   # http://localhost:8099
```

Licencja: MIT. Three.js (MIT) jest wbudowany w paczki JS.
