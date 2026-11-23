/**
 * Automatyczne opisy grup leków na podstawie kodu ATC (Anatomical Therapeutic Chemical, WHO).
 *
 * Używane jako fallback, gdy substancji czynnej nie ma w słowniku `src/aliases.ts` –
 * dzięki temu każdy lek z kodem ATC (z obwieszczenia MZ lub Rejestru Produktów Leczniczych)
 * ma wypełnioną kartę „Na co pomaga i jak stosować”.
 *
 * Dopasowanie wybiera najdłuższy pasujący prefiks, np. dla „R05CB02” wygrywa „R05C”
 * (leki wykrztuśne) przed „R05” (leki na kaszel) i „R” (układ oddechowy).
 * Moduł jest czysty (bez I/O) – w pełni testowalny jednostkowo.
 */

export interface AtcGroup {
  /** Prefiks kodu ATC, np. „N02B”. */
  prefix: string;
  /** Krótka etykieta grupy, np. „Lek przeciwbólowy i przeciwgorączkowy”. */
  kategoria: string;
  /** Przystępny opis zastosowania grupy (1–2 zdania). */
  naCoPomaga: string;
  /** Domyślna wskazówka stosowania (używana, gdy postaci leku nie da się rozpoznać). */
  jakStosowac: string;
}

const ULOTKA = "Stosować zgodnie z ulotką dołączoną do opakowania lub zaleceniem lekarza albo farmaceuty.";
const DOUSTNIE = "Doustnie, popijając wodą, zgodnie z ulotką lub zaleceniem lekarza.";
const NA_SKORE = "Na oczyszczoną skórę, cienką warstwą, zgodnie z ulotką; po użyciu umyć ręce.";

const GROUPS: readonly AtcGroup[] = [
  /* ---------------------------------------------------------- A – przewód pokarmowy */
  {
    prefix: "A",
    kategoria: "Lek na przewód pokarmowy i przemianę materii",
    naCoPomaga: "Stosowany w dolegliwościach układu pokarmowego, zaburzeniach trawienia lub przemiany materii.",
    jakStosowac: DOUSTNIE,
  },
  {
    prefix: "A01",
    kategoria: "Lek stomatologiczny",
    naCoPomaga: "Łagodzi stany zapalne, ból i podrażnienia jamy ustnej, dziąseł i błony śluzowej.",
    jakStosowac: "Stosować w jamie ustnej (płukanie, pędzlowanie lub żel na dziąsła) zgodnie z ulotką.",
  },
  {
    prefix: "A02",
    kategoria: "Lek na zgagę, refluks i nadkwasotę",
    naCoPomaga: "Łagodzi zgagę, pieczenie w przełyku, refluks i dolegliwości związane z nadkwasotą żołądka.",
    jakStosowac: "Doustnie, doraźnie przy objawach lub przed posiłkiem, zgodnie z ulotką.",
  },
  {
    prefix: "A02A",
    kategoria: "Lek zobojętniający kwas żołądkowy",
    naCoPomaga: "Szybko zobojętnia nadmiar kwasu żołądkowego – łagodzi zgagę, pieczenie i niestrawność.",
    jakStosowac:
      "Doustnie, doraźnie po posiłku lub przy objawach (tabletki ssać lub żuć). Zachować 2 godziny odstępu od innych leków.",
  },
  {
    prefix: "A02B",
    kategoria: "Lek na zgagę, refluks i wrzody żołądka",
    naCoPomaga: "Zmniejsza wydzielanie kwasu żołądkowego – stosowany przy refluksie, zgadze i chorobie wrzodowej.",
    jakStosowac: "Doustnie, zwykle raz na dobę przed posiłkiem, połykając w całości.",
  },
  {
    prefix: "A03",
    kategoria: "Lek rozkurczowy na bóle brzucha",
    naCoPomaga: "Łagodzi skurcze i bóle brzucha, wzdęcia oraz dolegliwości czynnościowe przewodu pokarmowego.",
    jakStosowac: DOUSTNIE,
  },
  {
    prefix: "A04",
    kategoria: "Lek przeciwwymiotny",
    naCoPomaga: "Zapobiega nudnościom i wymiotom (m.in. w chorobie lokomocyjnej lub po chemioterapii).",
    jakStosowac: DOUSTNIE,
  },
  {
    prefix: "A05",
    kategoria: "Lek na wątrobę i drogi żółciowe",
    naCoPomaga: "Wspomaga pracę wątroby i odpływ żółci, łagodzi dolegliwości trawienne po tłustych posiłkach.",
    jakStosowac: DOUSTNIE,
  },
  {
    prefix: "A06",
    kategoria: "Lek przeczyszczający",
    naCoPomaga: "Ułatwia wypróżnienie przy zaparciach.",
    jakStosowac: "Doustnie lub doodbytniczo, krótkotrwale, zgodnie z ulotką; pić dużo płynów.",
  },
  {
    prefix: "A07",
    kategoria: "Lek przeciwbiegunkowy i osłonowy na jelita",
    naCoPomaga: "Hamuje biegunkę, osłania błonę śluzową jelit i pomaga odbudować prawidłową florę jelitową.",
    jakStosowac: "Doustnie, zgodnie z ulotką; przy biegunce uzupełniać płyny i elektrolity.",
  },
  {
    prefix: "A08",
    kategoria: "Lek wspomagający odchudzanie",
    naCoPomaga: "Wspomaga redukcję masy ciała razem z dietą i aktywnością fizyczną.",
    jakStosowac: DOUSTNIE,
  },
  {
    prefix: "A09",
    kategoria: "Lek wspomagający trawienie (enzymy)",
    naCoPomaga: "Uzupełnia enzymy trawienne – łagodzi uczucie pełności i niestrawność.",
    jakStosowac: "Doustnie, w trakcie posiłku, połykając w całości.",
  },
  {
    prefix: "A10",
    kategoria: "Lek przeciwcukrzycowy",
    naCoPomaga: "Obniża poziom cukru we krwi w cukrzycy.",
    jakStosowac: "Zgodnie z zaleceniem diabetologa, regularnie o stałych porach; kontrolować glikemię.",
  },
  {
    prefix: "A11",
    kategoria: "Witaminy",
    naCoPomaga: "Uzupełnia niedobory witamin i wspiera odporność oraz prawidłowe funkcjonowanie organizmu.",
    jakStosowac: "Doustnie, najlepiej w trakcie posiłku; nie przekraczać zalecanej dawki dobowej.",
  },
  {
    prefix: "A12",
    kategoria: "Minerały i elektrolity",
    naCoPomaga: "Uzupełnia niedobory składników mineralnych (np. magnezu, wapnia, potasu).",
    jakStosowac: "Doustnie, w trakcie lub po posiłku, popijając wodą; nie przekraczać zalecanej dawki.",
  },
  /* ---------------------------------------------------------- B – krew */
  {
    prefix: "B",
    kategoria: "Lek wpływający na krew",
    naCoPomaga: "Wpływa na krzepnięcie lub skład krwi albo uzupełnia płyny i elektrolity.",
    jakStosowac: ULOTKA,
  },
  {
    prefix: "B01",
    kategoria: "Lek przeciwzakrzepowy",
    naCoPomaga: "Zapobiega powstawaniu zakrzepów krwi, zmniejsza ryzyko zawału i udaru.",
    jakStosowac: "Regularnie o stałej porze, bez pomijania dawek; zgłaszać lekarzowi krwawienia.",
  },
  {
    prefix: "B03",
    kategoria: "Lek przeciwanemiczny",
    naCoPomaga: "Uzupełnia niedobór żelaza, kwasu foliowego lub witaminy B12 przy niedokrwistości.",
    jakStosowac: DOUSTNIE,
  },
  /* ---------------------------------------------------------- C – układ sercowo-naczyniowy */
  {
    prefix: "C",
    kategoria: "Lek na serce i układ krążenia",
    naCoPomaga: "Stosowany w chorobach serca i naczyń krwionośnych.",
    jakStosowac: "Regularnie o stałej porze zgodnie z zaleceniem lekarza; nie odstawiać samodzielnie.",
  },
  {
    prefix: "C01",
    kategoria: "Lek nasercowy",
    naCoPomaga: "Wspomaga pracę serca – stosowany m.in. w chorobie wieńcowej i zaburzeniach rytmu.",
    jakStosowac: "Zgodnie z zaleceniem kardiologa, regularnie o stałej porze.",
  },
  {
    prefix: "C02",
    kategoria: "Lek na nadciśnienie",
    naCoPomaga: "Obniża ciśnienie tętnicze krwi.",
    jakStosowac: "Doustnie, regularnie o stałej porze; nie odstawiać bez konsultacji z lekarzem.",
  },
  {
    prefix: "C03",
    kategoria: "Lek moczopędny",
    naCoPomaga: "Usuwa nadmiar wody z organizmu – stosowany w nadciśnieniu, obrzękach i niewydolności serca.",
    jakStosowac: "Doustnie, zwykle rano, aby uniknąć oddawania moczu w nocy.",
  },
  {
    prefix: "C05",
    kategoria: "Lek na żylaki i obrzęki nóg",
    naCoPomaga: "Uszczelnia i wzmacnia naczynia krwionośne, łagodzi uczucie ciężkich nóg, obrzęki i żylaki.",
    jakStosowac:
      "Doustnie w trakcie posiłku lub miejscowo na skórę nóg, zgodnie z ulotką; kurację prowadzić regularnie.",
  },
  {
    prefix: "C05A",
    kategoria: "Lek na hemoroidy",
    naCoPomaga: "Łagodzi ból, świąd i pieczenie przy hemoroidach (żylakach odbytu).",
    jakStosowac: "Miejscowo w okolicy odbytu lub doodbytniczo, zwykle po wypróżnieniu, zgodnie z ulotką.",
  },
  {
    prefix: "C07",
    kategoria: "Lek na nadciśnienie i serce (beta-bloker)",
    naCoPomaga: "Zwalnia i stabilizuje pracę serca, obniża ciśnienie tętnicze.",
    jakStosowac: "Doustnie, regularnie o stałej porze; nie odstawiać nagle.",
  },
  {
    prefix: "C08",
    kategoria: "Lek na nadciśnienie (antagonista wapnia)",
    naCoPomaga: "Rozszerza naczynia krwionośne i obniża ciśnienie tętnicze.",
    jakStosowac: "Doustnie, regularnie o stałej porze.",
  },
  {
    prefix: "C09",
    kategoria: "Lek na nadciśnienie i serce",
    naCoPomaga: "Obniża ciśnienie tętnicze, chroni serce i nerki.",
    jakStosowac: "Doustnie, zwykle raz na dobę o stałej porze; stosować regularnie.",
  },
  {
    prefix: "C10",
    kategoria: "Lek obniżający cholesterol",
    naCoPomaga: "Obniża stężenie cholesterolu i trójglicerydów, zmniejsza ryzyko zawału i udaru.",
    jakStosowac: "Doustnie, raz na dobę o stałej porze.",
  },
  /* ---------------------------------------------------------- D – skóra */
  {
    prefix: "D",
    kategoria: "Lek dermatologiczny",
    naCoPomaga: "Stosowany w chorobach i podrażnieniach skóry.",
    jakStosowac: NA_SKORE,
  },
  {
    prefix: "D01",
    kategoria: "Lek przeciwgrzybiczy na skórę",
    naCoPomaga: "Zwalcza grzybice skóry i paznokci – m.in. grzybicę stóp, pachwin i drożdżycę skóry.",
    jakStosowac:
      "Na skórę zmienioną chorobowo i jej okolicę, regularnie także przez 1–2 tygodnie po ustąpieniu objawów.",
  },
  {
    prefix: "D02",
    kategoria: "Lek nawilżający i ochronny na skórę",
    naCoPomaga: "Natłuszcza, nawilża i chroni suchą lub podrażnioną skórę.",
    jakStosowac: NA_SKORE,
  },
  {
    prefix: "D03",
    kategoria: "Lek na rany i oparzenia",
    naCoPomaga: "Przyspiesza gojenie ran, otarć i oparzeń.",
    jakStosowac: "Na oczyszczoną ranę, cienką warstwą, zgodnie z ulotką.",
  },
  {
    prefix: "D04",
    kategoria: "Lek przeciwświądowy",
    naCoPomaga: "Łagodzi swędzenie skóry, m.in. po ukąszeniach owadów i przy podrażnieniach.",
    jakStosowac: NA_SKORE,
  },
  {
    prefix: "D06",
    kategoria: "Lek na zakażenia skóry",
    naCoPomaga: "Zwalcza bakteryjne lub wirusowe zakażenia skóry (np. opryszczkę).",
    jakStosowac: NA_SKORE,
  },
  {
    prefix: "D07",
    kategoria: "Maść przeciwzapalna na zmiany skórne (steroid)",
    naCoPomaga: "Zmniejsza stan zapalny, zaczerwienienie i świąd skóry, m.in. w egzemie i atopowym zapaleniu skóry.",
    jakStosowac: "Cienką warstwą na zmienioną skórę, krótkotrwale; nie stosować na twarz bez konsultacji z lekarzem.",
  },
  {
    prefix: "D08",
    kategoria: "Środek odkażający",
    naCoPomaga: "Odkaża skórę, rany i błony śluzowe, zapobiegając zakażeniom.",
    jakStosowac: "Miejscowo na skórę lub ranę, zgodnie z ulotką.",
  },
  {
    prefix: "D10",
    kategoria: "Lek przeciwtrądzikowy",
    naCoPomaga: "Zmniejsza zmiany trądzikowe i stan zapalny skóry.",
    jakStosowac: "Na oczyszczoną skórę twarzy, zwykle wieczorem; chronić skórę przed słońcem.",
  },
  {
    prefix: "D11",
    kategoria: "Preparat dermatologiczny",
    naCoPomaga: "Łagodzi dolegliwości skóry, owłosionej skóry głowy lub dziąseł.",
    jakStosowac: NA_SKORE,
  },
  /* ---------------------------------------------------------- G – układ moczowo-płciowy */
  {
    prefix: "G",
    kategoria: "Lek na układ moczowo-płciowy",
    naCoPomaga: "Stosowany w dolegliwościach układu moczowego lub rozrodczego.",
    jakStosowac: ULOTKA,
  },
  {
    prefix: "G01",
    kategoria: "Lek ginekologiczny przeciwzakaźny",
    naCoPomaga: "Zwalcza infekcje intymne (grzybicze lub bakteryjne) pochwy.",
    jakStosowac: "Dopochwowo, najlepiej wieczorem przed snem, przez zalecony okres.",
  },
  {
    prefix: "G03",
    kategoria: "Lek hormonalny",
    naCoPomaga: "Hormony płciowe – antykoncepcja, terapia hormonalna lub leczenie zaburzeń hormonalnych.",
    jakStosowac: "Codziennie o stałej porze zgodnie z zaleceniem lekarza.",
  },
  {
    prefix: "G04",
    kategoria: "Lek urologiczny",
    naCoPomaga: "Łagodzi dolegliwości dróg moczowych i prostaty, m.in. częste parcie na mocz.",
    jakStosowac: DOUSTNIE,
  },
  /* ---------------------------------------------------------- H, J, L – leki ogólnoustrojowe */
  {
    prefix: "H",
    kategoria: "Lek hormonalny",
    naCoPomaga: "Reguluje działanie hormonów (np. tarczycy, kory nadnerczy).",
    jakStosowac: "Regularnie o stałej porze zgodnie z zaleceniem lekarza.",
  },
  {
    prefix: "J",
    kategoria: "Lek przeciwzakaźny",
    naCoPomaga: "Zwalcza zakażenia bakteryjne, wirusowe lub grzybicze albo im zapobiega (szczepionki).",
    jakStosowac: "Przez cały zalecony okres, w równych odstępach czasu – nie przerywać kuracji samodzielnie.",
  },
  {
    prefix: "J05",
    kategoria: "Lek przeciwwirusowy",
    naCoPomaga: "Hamuje namnażanie wirusów, m.in. opryszczki i grypy.",
    jakStosowac: "Jak najwcześniej od pojawienia się objawów, zgodnie z ulotką lub zaleceniem lekarza.",
  },
  {
    prefix: "L",
    kategoria: "Lek przeciwnowotworowy lub immunomodulujący",
    naCoPomaga: "Stosowany w leczeniu nowotworów i chorób autoimmunologicznych.",
    jakStosowac: "Wyłącznie zgodnie z zaleceniem lekarza specjalisty i pod jego kontrolą.",
  },
  /* ---------------------------------------------------------- M – układ mięśniowo-szkieletowy */
  {
    prefix: "M",
    kategoria: "Lek na mięśnie, stawy i kości",
    naCoPomaga: "Stosowany w chorobach i dolegliwościach mięśni, stawów i kości.",
    jakStosowac: ULOTKA,
  },
  {
    prefix: "M01A",
    kategoria: "Lek przeciwzapalny i przeciwbólowy na stawy i mięśnie",
    naCoPomaga: "Łagodzi ból, stan zapalny i obrzęk – m.in. bóle stawów, mięśni, kręgosłupa, głowy i zębów.",
    jakStosowac:
      "Doustnie, w trakcie lub po posiłku, popijając wodą; jak najkrócej i w najmniejszej skutecznej dawce. " +
      "Nie łączyć z innymi lekami przeciwzapalnymi.",
  },
  {
    prefix: "M02A",
    kategoria: "Lek przeciwbólowy do stosowania na skórę",
    naCoPomaga: "Miejscowo łagodzi ból i stan zapalny mięśni, stawów, ścięgien – np. po urazach i przeciążeniach.",
    jakStosowac: "Wmasować w skórę nad bolesnym miejscem kilka razy dziennie; nie stosować na uszkodzoną skórę.",
  },
  {
    prefix: "M03",
    kategoria: "Lek rozluźniający mięśnie",
    naCoPomaga: "Zmniejsza napięcie i skurcze mięśni szkieletowych.",
    jakStosowac: DOUSTNIE,
  },
  {
    prefix: "M04",
    kategoria: "Lek na dnę moczanową",
    naCoPomaga: "Obniża stężenie kwasu moczowego lub łagodzi napady dny moczanowej.",
    jakStosowac: DOUSTNIE,
  },
  {
    prefix: "M05",
    kategoria: "Lek na osteoporozę",
    naCoPomaga: "Wzmacnia kości i zmniejsza ryzyko złamań w osteoporozie.",
    jakStosowac:
      "Zgodnie z ulotką – niektóre leki przyjmuje się rano na czczo, na stojąco, popijając dużą ilością wody.",
  },
  /* ---------------------------------------------------------- N – układ nerwowy */
  {
    prefix: "N",
    kategoria: "Lek działający na układ nerwowy",
    naCoPomaga: "Stosowany w dolegliwościach i chorobach układu nerwowego.",
    jakStosowac: "Zgodnie z zaleceniem lekarza; może wpływać na zdolność prowadzenia pojazdów.",
  },
  {
    prefix: "N01",
    kategoria: "Lek znieczulający",
    naCoPomaga: "Znieczula miejscowo lub ogólnie – łagodzi ból podczas zabiegów.",
    jakStosowac: ULOTKA,
  },
  {
    prefix: "N02",
    kategoria: "Lek przeciwbólowy",
    naCoPomaga: "Łagodzi ból o różnym nasileniu.",
    jakStosowac: "Zgodnie z ulotką lub zaleceniem lekarza, z zachowaniem odstępów między dawkami.",
  },
  {
    prefix: "N02B",
    kategoria: "Lek przeciwbólowy i przeciwgorączkowy",
    naCoPomaga: "Łagodzi ból głowy, zębów, mięśni, menstruacyjny i obniża gorączkę, m.in. przy przeziębieniu i grypie.",
    jakStosowac:
      "Doustnie, z zachowaniem co najmniej 4–6 godzin przerwy między dawkami. Nie przekraczać dawki dobowej " +
      "i nie łączyć z innymi lekami zawierającymi tę samą substancję.",
  },
  {
    prefix: "N02C",
    kategoria: "Lek przeciwmigrenowy",
    naCoPomaga: "Przerywa napad migreny lub mu zapobiega.",
    jakStosowac: "Doustnie, jak najwcześniej po pojawieniu się bólu migrenowego, zgodnie z ulotką.",
  },
  {
    prefix: "N05C",
    kategoria: "Lek nasenny i uspokajający",
    naCoPomaga: "Ułatwia zasypianie i łagodzi napięcie nerwowe.",
    jakStosowac: "Doustnie, wieczorem przed snem; nie łączyć z alkoholem i nie prowadzić pojazdów.",
  },
  {
    prefix: "N06",
    kategoria: "Lek psychoanaleptyczny",
    naCoPomaga: "Poprawia nastrój, koncentrację lub pamięć.",
    jakStosowac: "Regularnie zgodnie z zaleceniem lekarza; efekt pojawia się zwykle po kilku tygodniach.",
  },
  {
    prefix: "N07B",
    kategoria: "Lek stosowany w uzależnieniach",
    naCoPomaga: "Pomaga rzucić palenie lub łagodzi objawy odstawienia nikotyny.",
    jakStosowac: "Zgodnie z ulotką, stopniowo zmniejszając dawkę w trakcie kuracji.",
  },
  {
    prefix: "N07C",
    kategoria: "Lek przeciw zawrotom głowy",
    naCoPomaga: "Łagodzi zawroty głowy, szumy uszne i objawy choroby lokomocyjnej.",
    jakStosowac: DOUSTNIE,
  },
  /* ---------------------------------------------------------- P – pasożyty */
  {
    prefix: "P",
    kategoria: "Lek przeciwpasożytniczy",
    naCoPomaga: "Zwalcza pasożyty – owsiki, glisty, wszy lub świerzb.",
    jakStosowac: "Zgodnie z ulotką; często zaleca się leczenie wszystkich domowników jednocześnie.",
  },
  /* ---------------------------------------------------------- R – układ oddechowy */
  {
    prefix: "R",
    kategoria: "Lek na układ oddechowy",
    naCoPomaga: "Stosowany w dolegliwościach dróg oddechowych.",
    jakStosowac: ULOTKA,
  },
  {
    prefix: "R01",
    kategoria: "Lek na katar i zatoki",
    naCoPomaga: "Łagodzi katar, obrzęk błony śluzowej nosa i objawy zapalenia zatok.",
    jakStosowac: "Donosowo lub doustnie zgodnie z ulotką.",
  },
  {
    prefix: "R01A",
    kategoria: "Lek udrażniający nos przy katarze i zapaleniu zatok",
    naCoPomaga: "Zmniejsza obrzęk błony śluzowej nosa – udrażnia nos przy katarze, alergii i zapaleniu zatok.",
    jakStosowac: "Donosowo, zgodnie z ulotką. Krople i aerozole obkurczające naczynia stosować nie dłużej niż 5–7 dni.",
  },
  {
    prefix: "R02A",
    kategoria: "Lek na ból i stan zapalny gardła",
    naCoPomaga: "Łagodzi ból, drapanie i stan zapalny gardła, działa odkażająco w jamie ustnej.",
    jakStosowac: "Tabletki powoli ssać, aerozol rozpylać na gardło; nie jeść i nie pić bezpośrednio po zastosowaniu.",
  },
  {
    prefix: "R03",
    kategoria: "Lek na astmę i POChP",
    naCoPomaga: "Rozszerza oskrzela i zmniejsza stan zapalny dróg oddechowych – ułatwia oddychanie.",
    jakStosowac: "Wziewnie zgodnie z instrukcją inhalatora i zaleceniem lekarza.",
  },
  {
    prefix: "R05",
    kategoria: "Lek na kaszel i przeziębienie",
    naCoPomaga: "Łagodzi kaszel i objawy przeziębienia.",
    jakStosowac: DOUSTNIE,
  },
  {
    prefix: "R05C",
    kategoria: "Lek wykrztuśny na kaszel mokry",
    naCoPomaga: "Rozrzedza zalegającą wydzielinę i ułatwia jej odkrztuszanie przy kaszlu mokrym.",
    jakStosowac: "Doustnie, popijając dużą ilością płynów; ostatnią dawkę przyjąć kilka godzin przed snem.",
  },
  {
    prefix: "R05D",
    kategoria: "Lek przeciwkaszlowy na kaszel suchy",
    naCoPomaga: "Hamuje odruch kaszlu – łagodzi męczący, suchy kaszel bez odkrztuszania wydzieliny.",
    jakStosowac: "Doustnie zgodnie z ulotką; nie łączyć z lekami wykrztuśnymi.",
  },
  {
    prefix: "R06A",
    kategoria: "Lek przeciwalergiczny",
    naCoPomaga: "Łagodzi objawy alergii – katar sienny, łzawienie i swędzenie oczu, pokrzywkę i świąd skóry.",
    jakStosowac: "Doustnie, zwykle raz na dobę; u niektórych osób może powodować senność.",
  },
  /* ---------------------------------------------------------- S – narządy zmysłów */
  {
    prefix: "S",
    kategoria: "Lek na oczy lub uszy",
    naCoPomaga: "Stosowany w dolegliwościach oczu lub uszu.",
    jakStosowac: ULOTKA,
  },
  {
    prefix: "S01",
    kategoria: "Krople lub maść do oczu",
    naCoPomaga: "Łagodzi podrażnienie, suchość, zaczerwienienie, alergię lub infekcję oczu.",
    jakStosowac: "Do worka spojówkowego, nie dotykając końcówką oka; między różnymi kroplami zachować 5 minut przerwy.",
  },
  {
    prefix: "S02",
    kategoria: "Krople do uszu",
    naCoPomaga: "Łagodzi ból i stan zapalny ucha lub usuwa woskowinę.",
    jakStosowac: "Zakraplać do przewodu słuchowego, ogrzawszy wcześniej buteleczkę w dłoni.",
  },
  /* ---------------------------------------------------------- V – różne */
  {
    prefix: "V",
    kategoria: "Preparat leczniczy",
    naCoPomaga: "Preparat stosowany w szczególnych wskazaniach (np. diagnostyka, odtrutki, żywienie medyczne).",
    jakStosowac: ULOTKA,
  },
];

/** Prefiksy posortowane od najdłuższego – pierwsze trafienie jest najbardziej szczegółowe. */
const BY_LENGTH: readonly AtcGroup[] = [...GROUPS].sort((a, b) => b.prefix.length - a.prefix.length);

/** Liczba zdefiniowanych prefiksów ATC. */
export const ATC_GROUP_COUNT = GROUPS.length;

/**
 * Normalizuje kod ATC („ n02be01 ” → „N02BE01”); null dla pustego / niepoprawnego kodu („BRAK”).
 * Gdy pole zawiera kilka kodów („C05AX03, C05AD01”), zwracany jest pierwszy poprawny.
 */
export function normalizeAtc(code: string | null | undefined): string | null {
  for (const part of (code ?? "").toUpperCase().split(/[,;/|\s]+/)) {
    if (/^[A-Z][0-9]{2}[A-Z0-9]{0,4}$/.test(part) || /^[A-Z]$/.test(part)) return part;
  }
  return null;
}

/** Zwraca najbardziej szczegółową grupę ATC dla kodu (null, gdy brak dopasowania). */
export function atcGroup(code: string | null | undefined): AtcGroup | null {
  const normalized = normalizeAtc(code);
  if (normalized === null) return null;
  return BY_LENGTH.find((g) => normalized.startsWith(g.prefix)) ?? null;
}
