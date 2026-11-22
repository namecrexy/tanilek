/**
 * Słownik synonimów dla wyszukiwarki TaniLek.
 *
 * Pacjenci rzadko znają łacińskie nazwy INN z obwieszczenia Ministra Zdrowia
 * („Paracetamolum”, „Diazepamum”). Wpisują marki z reklam (Apap, Ibuprom, Relanium),
 * polskie nazwy substancji (paracetamol, atorwastatyna) albo robią literówki.
 * Ten moduł tłumaczy takie zapytania na łacińską substancję czynną z bazy MZ.
 *
 * Moduł jest czysty (bez I/O) – w pełni testowalny jednostkowo.
 */

import type { SubstanceDescription } from "./types";

/** Opis substancji czynnej dla pacjenta (kategoria, zastosowanie, sposób przyjmowania). */
export type SubstanceInfo = Pick<SubstanceDescription, "kategoria" | "naCoPomaga" | "jakStosowac">;

interface SubstanceEntry extends SubstanceInfo {
  /** Popularne marki handlowe i polskie nazwy kierujące do substancji. */
  aliasy: readonly string[];
}

/* Często powtarzane wskazówki dawkowania. */
const PO_POSILKU = "Doustnie, w trakcie lub po posiłku, popijając wodą. Dawkowanie ustala lekarz lub ulotka.";
const NSAID =
  "Doustnie, w trakcie lub po posiłku, popijając wodą; jak najkrócej i w najmniejszej skutecznej dawce. " +
  "Nie łączyć z innymi lekami przeciwzapalnymi.";
const STALA_PORA =
  "Doustnie, codziennie o stałej porze, popijając wodą – niezależnie od posiłku. Dawkowanie ustala lekarz.";
const NADCISNIENIE =
  "Doustnie, zwykle raz na dobę o stałej porze, popijając wodą. Stosować regularnie, także przy dobrym " +
  "samopoczuciu; nie odstawiać bez konsultacji z lekarzem.";
const STATYNA =
  "Doustnie, raz na dobę o stałej porze, niezależnie od posiłku. Unikać dużych ilości soku grejpfrutowego.";
const IPP =
  "Doustnie, zwykle raz na dobę rano, 30–60 minut przed posiłkiem; połykać w całości, bez rozgryzania i kruszenia.";
const ANTYBIOTYK =
  "Doustnie, w równych odstępach czasu, przez cały zalecony okres – nie przerywać kuracji po ustąpieniu objawów.";
const DEPRESJA =
  "Doustnie, raz na dobę o stałej porze. Pełny efekt pojawia się zwykle po 2–4 tygodniach; nie odstawiać " +
  "nagle bez konsultacji z lekarzem.";
const BENZO =
  "Doustnie, krótkotrwale i wyłącznie zgodnie z zaleceniem lekarza – może uzależniać. Nie łączyć z alkoholem " +
  "i nie prowadzić pojazdów.";
const PSYCHOZA =
  "Doustnie, codziennie o stałej porze zgodnie z zaleceniem psychiatry. Nie odstawiać samodzielnie; może " +
  "powodować senność.";
const PADACZKA =
  "Doustnie, regularnie o stałych porach. Nie pomijać dawek i nie odstawiać nagle – grozi to nawrotem napadów.";
const OPIOID =
  "Wyłącznie zgodnie z zaleceniem lekarza, w stałych odstępach czasu. Może uzależniać i powodować senność – " +
  "nie łączyć z alkoholem, nie prowadzić pojazdów.";
const ANTYKOAGULANT =
  "Doustnie, codziennie o stałej porze, bez pomijania dawek. Nie odstawiać przed zabiegiem bez konsultacji " +
  "z lekarzem; zgłaszać krwawienia.";
const ANTYHISTAMINA = "Doustnie, zwykle raz na dobę, niezależnie od posiłku. U niektórych osób może powodować senność.";
const STERYD_WZIEWNY =
  "Wziewnie, regularnie codziennie zgodnie z instrukcją inhalatora; po każdym użyciu przepłukać usta wodą.";
const WZIEWNY_DORAZNY = "Wziewnie, doraźnie w razie duszności lub przed wysiłkiem, zgodnie z instrukcją inhalatora.";
const WZIEWNY_STALY =
  "Wziewnie, regularnie o stałych porach zgodnie z instrukcją inhalatora – nie służy do przerywania napadu.";
const NOS = "Donosowo, regularnie zgodnie z ulotką; przed pierwszym użyciem i po przerwie przygotować pompkę.";
const WYKRZTUSNY = "Doustnie, popijając dużą ilością płynów; nie stosować tuż przed snem.";
const GLIFLOZYNA =
  "Doustnie, raz na dobę o stałej porze, niezależnie od posiłku; pić odpowiednią ilość wody i dbać o higienę " +
  "okolic intymnych.";
const KORTYKOSTEROID =
  "Doustnie, zwykle rano po posiłku. Przy dłuższym leczeniu nie odstawiać nagle – dawkę zmniejsza się stopniowo.";
const OKO =
  "Do worka spojówkowego, regularnie o stałej porze; między różnymi kroplami do oczu zachować 5 minut przerwy.";

/* Często powtarzane kategorie. */
const K_BOL = "Lek przeciwbólowy i przeciwzapalny";
const K_STATYNA = "Lek obniżający cholesterol (statyna)";
const K_SERCE = "Lek na nadciśnienie i serce";
const K_DIUR = "Lek moczopędny";
const K_ANTYKO = "Lek przeciwzakrzepowy";
const K_CUKRZYCA = "Lek przeciwcukrzycowy";
const K_IPP = "Lek zmniejszający wydzielanie kwasu żołądkowego";
const K_ANTYB = "Antybiotyk";
const K_DEPR = "Lek przeciwdepresyjny";
const K_PSYCH = "Lek przeciwpsychotyczny";
const K_PADACZKA = "Lek przeciwpadaczkowy";
const K_OPIOID = "Silny lek przeciwbólowy (opioid)";
const K_ALERGIA = "Lek przeciwalergiczny";
const K_ASTMA = "Lek na astmę i POChP";
const K_KASZEL = "Lek wykrztuśny";

const T_BOL = "Łagodzi ból o różnym pochodzeniu (głowy, zębów, mięśni, stawów, menstruacyjny), obniża gorączkę";
const T_SERCE_NT = "Obniża ciśnienie tętnicze krwi i zmniejsza ryzyko zawału serca oraz udaru";
const T_STATYNA =
  "Obniża stężenie cholesterolu LDL i zmniejsza ryzyko zawału serca oraz udaru mózgu. Stosowany przy " +
  "hipercholesterolemii i miażdżycy.";

/**
 * Łacińska substancja czynna (INN) → opis dla pacjenta oraz popularne marki handlowe i polskie nazwy.
 *
 * Klucz jest dopasowywany do kolumny `substancja_czynna` z obwieszczenia MZ przez rdzeń nazwy
 * ({@link substanceStem}), np. „Metforminum” pasuje do „Metformini hydrochloridum”.
 */
const SUBSTANCES: Readonly<Record<string, SubstanceEntry>> = {
  /* ---------------------------------------------------- Ból, gorączka, stan zapalny */
  Paracetamolum: {
    kategoria: "Lek przeciwbólowy i przeciwgorączkowy",
    naCoPomaga: `${T_BOL}. Nie działa przeciwzapalnie, ale jest łagodny dla żołądka.`,
    jakStosowac:
      "Doustnie lub doodbytniczo, z zachowaniem co najmniej 4–6 godzin przerwy między dawkami. Nie przekraczać " +
      "dawki dobowej z ulotki i nie łączyć z innymi lekami zawierającymi paracetamol ani z alkoholem.",
    aliasy: [
      "apap",
      "apap extra",
      "apap noc",
      "panadol",
      "panadol extra",
      "efferalgan",
      "paracetamol",
      "codipar",
      "calpol",
      "pedicetamol",
      "paracetamol accord",
    ],
  },
  Ibuprofenum: {
    kategoria: K_BOL,
    naCoPomaga: `${T_BOL}, zmniejsza stan zapalny i obrzęk.`,
    jakStosowac: NSAID,
    aliasy: [
      "ibuprom",
      "ibuprom max",
      "ibuprom sprint",
      "nurofen",
      "nurofen forte",
      "nurofen express",
      "ibum",
      "mig",
      "ibuprofen",
      "ibufen",
      "ibalgin",
      "ibupar",
      "modafen",
      "metafen",
      "brufen",
    ],
  },
  Ketoprofenum: {
    kategoria: K_BOL,
    naCoPomaga: "Silnie łagodzi ból i stan zapalny, m.in. w chorobach stawów, urazach, bólach kręgosłupa i zębów.",
    jakStosowac: NSAID,
    aliasy: [
      "ketonal",
      "ketonal active",
      "ketonal forte",
      "ketonal duo",
      "refastin",
      "ketoprofen",
      "profenid",
      "febrofen",
    ],
  },
  Dexketoprofenum: {
    kategoria: K_BOL,
    naCoPomaga:
      "Łagodzi ostry ból o nasileniu łagodnym i umiarkowanym, np. bóle zębów, mięśni, stawów i menstruacyjne.",
    jakStosowac: `${NSAID} Lek do krótkotrwałego stosowania.`,
    aliasy: ["dexak", "dexak sl", "skudexa", "deksketoprofen", "dexketoprofen", "ketesse"],
  },
  Diclofenacum: {
    kategoria: K_BOL,
    naCoPomaga: "Zmniejsza ból, obrzęk i stan zapalny w chorobach stawów, kręgosłupa, urazach i stanach pourazowych.",
    jakStosowac: NSAID,
    aliasy: [
      "voltaren",
      "voltaren max",
      "olfen",
      "dicloduo",
      "dicloberl",
      "majamil",
      "naklofen",
      "diklofenak",
      "diclofenac",
    ],
  },
  Naproxenum: {
    kategoria: K_BOL,
    naCoPomaga: `${T_BOL}; stosowany też w chorobach reumatycznych.`,
    jakStosowac: NSAID,
    aliasy: ["naproxen", "naproksen", "aleve", "anapran", "nalgesin"],
  },
  Nimesulidum: {
    kategoria: K_BOL,
    naCoPomaga: "Łagodzi ostry ból (np. zębów, pourazowy) i bolesne miesiączkowanie.",
    jakStosowac: "Doustnie, po posiłku, maksymalnie przez 15 dni. Saszetkę rozpuścić w szklance wody.",
    aliasy: ["nimesil", "aulin", "nimesulid", "nimesulide", "coxtral"],
  },
  Meloxicamum: {
    kategoria: K_BOL,
    naCoPomaga: "Zmniejsza ból i stan zapalny w chorobie zwyrodnieniowej stawów i reumatoidalnym zapaleniu stawów.",
    jakStosowac: `${NSAID} Zwykle raz na dobę.`,
    aliasy: ["movalis", "mel", "opokan", "meloksykam", "meloxicam", "aspicam"],
  },
  Celecoxibum: {
    kategoria: K_BOL,
    naCoPomaga: "Zmniejsza ból i stan zapalny w chorobie zwyrodnieniowej stawów i reumatoidalnym zapaleniu stawów.",
    jakStosowac: "Doustnie, raz lub dwa razy na dobę, niezależnie od posiłku. Dawkowanie ustala lekarz.",
    aliasy: ["celebrex", "aclexa", "celekoksyb", "celecoxib"],
  },
  Etoricoxibum: {
    kategoria: K_BOL,
    naCoPomaga:
      "Łagodzi ból i stan zapalny w chorobie zwyrodnieniowej stawów, RZS oraz w ostrym napadzie dny moczanowej.",
    jakStosowac: "Doustnie, raz na dobę, niezależnie od posiłku. Dawkowanie ustala lekarz.",
    aliasy: ["arcoxia", "roticox", "etorikoksyb", "etoricoxib"],
  },
  Metamizolum: {
    kategoria: "Lek przeciwbólowy, przeciwgorączkowy i rozkurczowy",
    naCoPomaga: "Łagodzi silny ból (także kolkowy) i obniża wysoką gorączkę, gdy inne leki nie pomagają.",
    jakStosowac: "Doustnie, popijając wodą, krótkotrwale i w odstępach podanych w ulotce.",
    aliasy: ["pyralgina", "pyralginum", "metamizol", "metamizole", "pyralgin"],
  },
  Tramadolum: {
    kategoria: K_OPIOID,
    naCoPomaga:
      "Łagodzi ból umiarkowany i silny, gdy słabsze leki nie wystarczają. Często łączony z paracetamolem " +
      "(np. Doreta, Zaldiar).",
    jakStosowac: OPIOID,
    aliasy: [
      "tramal",
      "poltram",
      "poltram combo",
      "tramadol",
      "tramundin",
      "doreta",
      "zaldiar",
      "exbol",
      "padolten",
      "tramadol paracetamol",
    ],
  },
  Oxycodonum: {
    kategoria: K_OPIOID,
    naCoPomaga: "Łagodzi silny, przewlekły ból, np. nowotworowy lub pooperacyjny.",
    jakStosowac: `${OPIOID} Tabletek o przedłużonym uwalnianiu nie kruszyć ani nie rozgryzać.`,
    aliasy: ["oxycontin", "reltebon", "targin", "oksykodon", "oxycodone"],
  },
  Morphinum: {
    kategoria: K_OPIOID,
    naCoPomaga: "Łagodzi bardzo silny ból, np. w chorobie nowotworowej lub po operacjach.",
    jakStosowac: OPIOID,
    aliasy: ["morfina", "mst continus", "vendal", "doltard", "morphine"],
  },
  Fentanylum: {
    kategoria: K_OPIOID,
    naCoPomaga: "Łagodzi silny, przewlekły ból wymagający stałego leczenia opioidami.",
    jakStosowac:
      "Plaster naklejać na czystą, nieowłosioną skórę i wymieniać co 72 godziny; nie ogrzewać miejsca " +
      "naklejenia. Stosować wyłącznie zgodnie z zaleceniem lekarza.",
    aliasy: ["durogesic", "fentanyl", "fentanyl sandoz", "matrifen"],
  },
  Buprenorphinum: {
    kategoria: K_OPIOID,
    naCoPomaga: "Łagodzi przewlekły ból umiarkowany i silny; stosowana także w leczeniu uzależnienia od opioidów.",
    jakStosowac: OPIOID,
    aliasy: ["transtec", "melodyn", "buprenorfina", "bupensan", "norspan"],
  },
  Drotaverinum: {
    kategoria: "Lek rozkurczowy",
    naCoPomaga: "Łagodzi bóle skurczowe brzucha, dróg żółciowych i moczowych oraz bolesne miesiączkowanie.",
    jakStosowac: "Doustnie, popijając wodą, niezależnie od posiłku. Dawkowanie wg ulotki.",
    aliasy: ["nospa", "no-spa", "no-spa max", "no-spa forte", "drotaweryna", "drotawerynum", "drotaverine"],
  },

  /* ---------------------------------------------------- Serce, nadciśnienie, krzepliwość */
  "Acidum acetylsalicylicum": {
    kategoria: "Lek przeciwpłytkowy i przeciwbólowy",
    naCoPomaga:
      "W małych dawkach (75–150 mg) chroni przed zawałem serca i udarem, zapobiegając zlepianiu się płytek krwi; " +
      "w większych dawkach działa przeciwbólowo i przeciwgorączkowo.",
    jakStosowac:
      "Doustnie, po posiłku, popijając wodą; dawkę kardiologiczną zwykle raz na dobę o stałej porze. Tabletek " +
      "dojelitowych nie rozgryzać.",
    aliasy: [
      "polopiryna",
      "aspiryna",
      "aspirin",
      "acard",
      "polocard",
      "kwas acetylosalicylowy",
      "acesan",
      "bestpirin",
      "encopirin",
      "aspirin cardio",
    ],
  },
  Clopidogrelum: {
    kategoria: "Lek przeciwpłytkowy",
    naCoPomaga: "Zapobiega powstawaniu zakrzepów po zawale, udarze, wszczepieniu stentu i w miażdżycy tętnic.",
    jakStosowac: `${STALA_PORA} Nie odstawiać przed zabiegiem bez konsultacji z kardiologiem.`,
    aliasy: ["plavix", "areplex", "zyllt", "klopidogrel", "clopidogrel", "egitromb", "trombex"],
  },
  Ticagrelorum: {
    kategoria: "Lek przeciwpłytkowy",
    naCoPomaga: "Zapobiega ponownemu zawałowi i zakrzepicy stentu u osób po ostrym zespole wieńcowym.",
    jakStosowac: "Doustnie, dwa razy na dobę o stałych porach, zwykle razem z małą dawką kwasu acetylosalicylowego.",
    aliasy: ["brilique", "tikagrelor", "ticagrelor"],
  },
  Rivaroxabanum: {
    kategoria: K_ANTYKO,
    naCoPomaga:
      "Zapobiega udarowi w migotaniu przedsionków oraz leczy i zapobiega zakrzepicy żył głębokich i zatorowości płucnej.",
    jakStosowac: `${ANTYKOAGULANT} Dawki 15 i 20 mg przyjmować z posiłkiem.`,
    aliasy: ["xarelto", "rywaroksaban", "rivaroxaban", "rivaxored"],
  },
  Apixabanum: {
    kategoria: K_ANTYKO,
    naCoPomaga:
      "Zapobiega udarowi w migotaniu przedsionków oraz leczy i zapobiega zakrzepicy żył głębokich i zatorowości płucnej.",
    jakStosowac: `${ANTYKOAGULANT} Zwykle dwa razy na dobę.`,
    aliasy: ["eliquis", "apiksaban", "apixaban", "apixaban zentiva"],
  },
  Dabigatranum: {
    kategoria: K_ANTYKO,
    naCoPomaga: "Zapobiega udarowi w migotaniu przedsionków oraz zakrzepicy żylnej, np. po endoprotezoplastyce.",
    jakStosowac: `${ANTYKOAGULANT} Kapsułki połykać w całości, nie otwierać.`,
    aliasy: ["pradaxa", "dabigatran", "dabigatranum", "dabigatran etexilate"],
  },
  Acenocoumarolum: {
    kategoria: "Lek przeciwzakrzepowy (antagonista witaminy K)",
    naCoPomaga: "Zapobiega zakrzepom i zatorom, np. w migotaniu przedsionków, po wszczepieniu sztucznej zastawki.",
    jakStosowac:
      "Doustnie, raz na dobę o tej samej porze. Wymaga regularnej kontroli INR; unikać gwałtownych zmian w diecie " +
      "(witamina K) i nowych leków bez konsultacji.",
    aliasy: ["aceno", "acenokumarol", "acenocumarol", "acenocumarol wzf", "sintrom"],
  },
  Warfarinum: {
    kategoria: "Lek przeciwzakrzepowy (antagonista witaminy K)",
    naCoPomaga: "Zapobiega zakrzepom i zatorom, np. w migotaniu przedsionków, po wszczepieniu sztucznej zastawki.",
    jakStosowac:
      "Doustnie, raz na dobę o tej samej porze. Wymaga regularnej kontroli INR; unikać gwałtownych zmian w diecie " +
      "(witamina K) i nowych leków bez konsultacji.",
    aliasy: ["warfin", "warfaryna", "warfarin", "coumadin"],
  },
  Enoxaparinum: {
    kategoria: "Lek przeciwzakrzepowy (heparyna drobnocząsteczkowa)",
    naCoPomaga: "Zapobiega zakrzepicy żył, np. po operacjach, urazach i w czasie unieruchomienia, oraz ją leczy.",
    jakStosowac:
      "Podskórnie, zwykle w skórę brzucha, raz lub dwa razy na dobę wg zaleceń lekarza; nie usuwać pęcherzyka " +
      "powietrza ze strzykawki i nie masować miejsca wkłucia.",
    aliasy: ["clexane", "neoparin", "enoksaparyna", "enoxaparin", "inhixa"],
  },
  Atorvastatinum: {
    kategoria: K_STATYNA,
    naCoPomaga: T_STATYNA,
    jakStosowac: STATYNA,
    aliasy: ["sortis", "atoris", "tulip", "atorwastatyna", "atorvastatin", "atorvasterol", "torvacard"],
  },
  Rosuvastatinum: {
    kategoria: K_STATYNA,
    naCoPomaga: T_STATYNA,
    jakStosowac: STATYNA,
    aliasy: [
      "roswera",
      "zahron",
      "rosuwastatyna",
      "rosuvastatin",
      "crestor",
      "romazic",
      "suvardio",
      "rosucard",
      "xeter",
    ],
  },
  Simvastatinum: {
    kategoria: K_STATYNA,
    naCoPomaga: T_STATYNA,
    jakStosowac: "Doustnie, raz na dobę wieczorem. Unikać soku grejpfrutowego.",
    aliasy: ["zocor", "vasilip", "simwastatyna", "simvastatin", "simvacard", "simvasterol"],
  },
  Ezetimibum: {
    kategoria: "Lek obniżający cholesterol",
    naCoPomaga:
      "Zmniejsza wchłanianie cholesterolu z jelit; zwykle stosowany razem ze statyną, gdy ona sama nie wystarcza.",
    jakStosowac: "Doustnie, raz na dobę o dowolnej, stałej porze, niezależnie od posiłku.",
    aliasy: ["ezehron", "ezehron duo", "ezetrol", "ezetymib", "ezetimibe", "atozet", "rosazimib"],
  },
  Fenofibratum: {
    kategoria: "Lek obniżający trójglicerydy (fibrat)",
    naCoPomaga: "Obniża podwyższone stężenie trójglicerydów i cholesterolu we krwi.",
    jakStosowac: "Doustnie, raz na dobę w trakcie głównego posiłku.",
    aliasy: ["lipanthyl", "lipanthyl supra", "fenofibrat", "fenofibrate", "grofibrat"],
  },
  Bisoprololum: {
    kategoria: `${K_SERCE} (beta-adrenolityk)`,
    naCoPomaga:
      "Obniża ciśnienie i zwalnia czynność serca; stosowany w nadciśnieniu, chorobie wieńcowej i niewydolności serca.",
    jakStosowac: `${NADCISNIENIE} Najlepiej rano.`,
    aliasy: ["concor", "concor cor", "bibloc", "bisoprolol", "bisocard", "coronal", "sobycor", "bisoratio"],
  },
  Metoprololum: {
    kategoria: `${K_SERCE} (beta-adrenolityk)`,
    naCoPomaga: "Obniża ciśnienie i zwalnia czynność serca; stosowany w nadciśnieniu, dławicy, zaburzeniach rytmu.",
    jakStosowac: `${NADCISNIENIE} Tabletek o przedłużonym uwalnianiu nie rozgryzać.`,
    aliasy: ["betaloc", "betaloc zok", "metocard", "metoprolol", "beto zk", "bloxazoc", "metocard zk"],
  },
  Nebivololum: {
    kategoria: `${K_SERCE} (beta-adrenolityk)`,
    naCoPomaga: "Obniża ciśnienie tętnicze i zwalnia czynność serca; stosowany też w przewlekłej niewydolności serca.",
    jakStosowac: NADCISNIENIE,
    aliasy: ["nebilet", "nedal", "nebivolol", "nebiwolol", "nebilenin"],
  },
  Carvedilolum: {
    kategoria: `${K_SERCE} (beta-adrenolityk)`,
    naCoPomaga: "Stosowany w nadciśnieniu tętniczym, chorobie wieńcowej i przewlekłej niewydolności serca.",
    jakStosowac: "Doustnie, zwykle dwa razy na dobę, w trakcie posiłku. Nie odstawiać nagle.",
    aliasy: ["dilatrend", "carvedilol", "karwedilol", "coryol", "carvetrend"],
  },
  Ramiprilum: {
    kategoria: `${K_SERCE} (inhibitor ACE)`,
    naCoPomaga: `${T_SERCE_NT}; chroni też nerki i serce w niewydolności serca oraz po zawale.`,
    jakStosowac: `${NADCISNIENIE} Może wywoływać suchy kaszel – zgłosić go lekarzowi.`,
    aliasy: ["tritace", "polpril", "ramipryl", "ramipril", "piramil", "ampril", "vivace", "axtil"],
  },
  Perindoprilum: {
    kategoria: `${K_SERCE} (inhibitor ACE)`,
    naCoPomaga: `${T_SERCE_NT}; stosowany też w stabilnej chorobie wieńcowej i niewydolności serca.`,
    jakStosowac: `${NADCISNIENIE} Najlepiej rano przed posiłkiem.`,
    aliasy: [
      "prestarium",
      "co-prestarium",
      "prenewel",
      "perindopryl",
      "perindopril",
      "prenessa",
      "co-prenessa",
      "dalnessa",
      "noliprel",
    ],
  },
  Enalaprilum: {
    kategoria: `${K_SERCE} (inhibitor ACE)`,
    naCoPomaga: `${T_SERCE_NT}; stosowany też w niewydolności serca.`,
    jakStosowac: NADCISNIENIE,
    aliasy: ["enap", "enarenal", "enalapryl", "enalapril", "benalapril"],
  },
  Lisinoprilum: {
    kategoria: `${K_SERCE} (inhibitor ACE)`,
    naCoPomaga: `${T_SERCE_NT}; stosowany też w niewydolności serca i po zawale.`,
    jakStosowac: NADCISNIENIE,
    aliasy: ["diroton", "lisinopril", "lizynopryl"],
  },
  Amlodipinum: {
    kategoria: `${K_SERCE} (antagonista wapnia)`,
    naCoPomaga: `${T_SERCE_NT}; stosowany też w dławicy piersiowej.`,
    jakStosowac: `${NADCISNIENIE} Może powodować obrzęki kostek.`,
    aliasy: [
      "norvasc",
      "amlozek",
      "amlopin",
      "tenox",
      "agen",
      "amlodypina",
      "amlodipina",
      "amlodipine",
      "aldan",
      "normodipine",
    ],
  },
  Lercanidipinum: {
    kategoria: `${K_SERCE} (antagonista wapnia)`,
    naCoPomaga: "Obniża ciśnienie tętnicze krwi.",
    jakStosowac: "Doustnie, raz na dobę, co najmniej 15 minut przed posiłkiem. Unikać soku grejpfrutowego.",
    aliasy: ["lercan", "lerkanidypina", "lercanidipine", "zanidip"],
  },
  Losartanum: {
    kategoria: `${K_SERCE} (sartan)`,
    naCoPomaga: `${T_SERCE_NT}; chroni nerki u chorych na cukrzycę.`,
    jakStosowac: NADCISNIENIE,
    aliasy: ["lorista", "losacor", "cozaar", "lozartan", "losartan"],
  },
  Valsartanum: {
    kategoria: `${K_SERCE} (sartan)`,
    naCoPomaga: `${T_SERCE_NT}; stosowany też w niewydolności serca i po zawale.`,
    jakStosowac: NADCISNIENIE,
    aliasy: ["valsacor", "diovan", "walsartan", "valsartan", "vanatex"],
  },
  Telmisartanum: {
    kategoria: `${K_SERCE} (sartan)`,
    naCoPomaga: T_SERCE_NT,
    jakStosowac: NADCISNIENIE,
    aliasy: ["micardis", "micardisplus", "telmisartan", "polsart", "telmizek", "tezeo", "telmisartan teva"],
  },
  Candesartanum: {
    kategoria: `${K_SERCE} (sartan)`,
    naCoPomaga: `${T_SERCE_NT}; stosowany też w niewydolności serca.`,
    jakStosowac: NADCISNIENIE,
    aliasy: ["atacand", "candepres", "karbis", "kandesartan", "candesartan", "carzap"],
  },
  Indapamidum: {
    kategoria: `${K_DIUR} (na nadciśnienie)`,
    naCoPomaga: "Obniża ciśnienie tętnicze krwi, zwiększając wydalanie sodu i wody z moczem.",
    jakStosowac: "Doustnie, raz na dobę rano, popijając wodą; tabletek o przedłużonym uwalnianiu nie rozgryzać.",
    aliasy: ["tertensif sr", "indapen", "indapen sr", "indapamid", "indix"],
  },
  Hydrochlorothiazidum: {
    kategoria: `${K_DIUR} (na nadciśnienie)`,
    naCoPomaga: "Obniża ciśnienie tętnicze i zmniejsza obrzęki; często składnik leków złożonych na nadciśnienie.",
    jakStosowac: "Doustnie, rano, popijając wodą. Chronić skórę przed silnym słońcem.",
    aliasy: ["hydrochlorotiazyd", "hydrochlorothiazide", "hct", "hydrochlorothiazidum polfa"],
  },
  Furosemidum: {
    kategoria: `${K_DIUR} (pętlowy)`,
    naCoPomaga: "Usuwa nadmiar wody z organizmu – zmniejsza obrzęki w niewydolności serca, chorobach nerek i wątroby.",
    jakStosowac: "Doustnie, rano na czczo (ewentualnie druga dawka do południa), by nie budzić się w nocy do toalety.",
    aliasy: ["furosemid", "furosemidum", "furosemide", "furosemid polpharma", "furosemidum polpharma"],
  },
  Torasemidum: {
    kategoria: `${K_DIUR} (pętlowy)`,
    naCoPomaga: "Zmniejsza obrzęki w niewydolności serca i obniża ciśnienie tętnicze.",
    jakStosowac: "Doustnie, raz na dobę rano, popijając wodą.",
    aliasy: ["trifas", "diuver", "toramide", "torasemid", "torasemide", "toramid"],
  },
  Spironolactonum: {
    kategoria: `${K_DIUR} (oszczędzający potas)`,
    naCoPomaga:
      "Zmniejsza obrzęki, wspiera leczenie niewydolności serca i opornego nadciśnienia; ogranicza utratę potasu.",
    jakStosowac: "Doustnie, w trakcie posiłku, zwykle rano. Nie stosować suplementów potasu bez zgody lekarza.",
    aliasy: ["verospiron", "spironol", "finospir", "spironolakton", "spironolactone", "spironolactone polpharma"],
  },
  Eplerenonum: {
    kategoria: `${K_DIUR} (oszczędzający potas)`,
    naCoPomaga: "Wspiera leczenie niewydolności serca, zwłaszcza po zawale.",
    jakStosowac: "Doustnie, raz na dobę, niezależnie od posiłku. Wymaga kontroli stężenia potasu we krwi.",
    aliasy: ["inspra", "eplerenon", "eplerenone"],
  },
  Doxazosinum: {
    kategoria: "Lek na nadciśnienie i przerost prostaty (alfa-adrenolityk)",
    naCoPomaga: "Obniża ciśnienie tętnicze i ułatwia oddawanie moczu przy łagodnym rozroście gruczołu krokowego.",
    jakStosowac: "Doustnie, raz na dobę. Przy pierwszych dawkach ostrożnie wstawać – możliwe zawroty głowy.",
    aliasy: ["cardura", "cardura xl", "doxar", "doksazosyna", "doxazosin", "zoxon", "kamiren"],
  },
  Ivabradinum: {
    kategoria: "Lek na serce (zwalniający rytm)",
    naCoPomaga: "Zwalnia czynność serca w przewlekłej niewydolności serca i stabilnej dławicy piersiowej.",
    jakStosowac: "Doustnie, dwa razy na dobę, rano i wieczorem, w trakcie posiłku.",
    aliasy: ["procoralan", "bixebra", "iwabradyna", "ivabradine"],
  },
  Trimetazidinum: {
    kategoria: "Lek na dławicę piersiową",
    naCoPomaga: "Wspomaga leczenie stabilnej dławicy piersiowej (choroby wieńcowej), poprawiając metabolizm serca.",
    jakStosowac: "Doustnie, zwykle dwa razy na dobę, rano i wieczorem, w trakcie posiłku.",
    aliasy: ["preductal", "preductal mr", "trimetazydyna", "trimetazidine"],
  },
  "Isosorbidi mononitras": {
    kategoria: "Lek na dławicę piersiową (azotan)",
    naCoPomaga: "Zapobiega bólom wieńcowym (dławicy piersiowej) przez rozszerzenie naczyń krwionośnych.",
    jakStosowac: "Doustnie, rano, o stałej porze. Nie łączyć z lekami na potencję (np. sildenafilem).",
    aliasy: ["mononit", "effox", "monosan", "izosorbid", "monoazotan izosorbidu"],
  },
  Amiodaronum: {
    kategoria: "Lek przeciwarytmiczny",
    naCoPomaga: "Leczy i zapobiega groźnym zaburzeniom rytmu serca, m.in. migotaniu przedsionków.",
    jakStosowac:
      "Doustnie, w trakcie posiłku, zgodnie ze schematem kardiologa. Wymaga kontroli tarczycy; chronić skórę przed słońcem.",
    aliasy: ["cordarone", "opacorden", "amiodaron", "amiodarone"],
  },
  Propafenonum: {
    kategoria: "Lek przeciwarytmiczny",
    naCoPomaga: "Przywraca i utrzymuje prawidłowy rytm serca, m.in. w napadowym migotaniu przedsionków.",
    jakStosowac: "Doustnie, po posiłku, popijając wodą, w równych odstępach czasu.",
    aliasy: ["rytmonorm", "polfenon", "propafenon", "propafenone"],
  },
  Digoxinum: {
    kategoria: "Lek nasercowy (glikozyd)",
    naCoPomaga: "Zwalnia czynność serca w migotaniu przedsionków i wspiera leczenie niewydolności serca.",
    jakStosowac: "Doustnie, raz na dobę o stałej porze. Wymaga kontroli stężenia leku we krwi; zgłaszać nudności.",
    aliasy: ["digoxin", "digoksyna"],
  },

  /* ---------------------------------------------------- Cukrzyca, tarczyca, dna */
  Metforminum: {
    kategoria: `${K_CUKRZYCA} (biguanid)`,
    naCoPomaga: "Obniża poziom cukru we krwi w cukrzycy typu 2; stosowana też w insulinooporności.",
    jakStosowac:
      "Doustnie, w trakcie lub tuż po posiłku, popijając wodą – zmniejsza to dolegliwości żołądkowe. " +
      "Dawkowanie ustala lekarz.",
    aliasy: [
      "glucophage",
      "glucophage xr",
      "siofor",
      "metformax",
      "metformina",
      "metformin",
      "formetic",
      "avamina",
      "metfogamma",
    ],
  },
  Gliclazidum: {
    kategoria: `${K_CUKRZYCA} (pochodna sulfonylomocznika)`,
    naCoPomaga: "Obniża poziom cukru we krwi w cukrzycy typu 2, pobudzając trzustkę do wydzielania insuliny.",
    jakStosowac:
      "Doustnie, raz na dobę podczas śniadania. Nie pomijać posiłków – grozi to niedocukrzeniem (hipoglikemią).",
    aliasy: ["diaprel", "diaprel mr", "gliklazyd", "gliclazide", "diagen", "gliclada"],
  },
  Glimepiridum: {
    kategoria: `${K_CUKRZYCA} (pochodna sulfonylomocznika)`,
    naCoPomaga: "Obniża poziom cukru we krwi w cukrzycy typu 2, pobudzając trzustkę do wydzielania insuliny.",
    jakStosowac:
      "Doustnie, raz na dobę tuż przed lub w trakcie śniadania. Nie pomijać posiłków – grozi to niedocukrzeniem.",
    aliasy: ["amaryl", "glimepiryd", "glimepiride", "avaron"],
  },
  Empagliflozinum: {
    kategoria: `${K_CUKRZYCA} (flozyna)`,
    naCoPomaga:
      "Obniża poziom cukru w cukrzycy typu 2, usuwając glukozę z moczem; chroni też serce i nerki, stosowana " +
      "w niewydolności serca.",
    jakStosowac: GLIFLOZYNA,
    aliasy: ["jardiance", "synjardy", "empagliflozyna", "empagliflozin"],
  },
  Dapagliflozinum: {
    kategoria: `${K_CUKRZYCA} (flozyna)`,
    naCoPomaga:
      "Obniża poziom cukru w cukrzycy typu 2, usuwając glukozę z moczem; stosowana też w niewydolności serca " +
      "i przewlekłej chorobie nerek.",
    jakStosowac: GLIFLOZYNA,
    aliasy: ["forxiga", "xigduo", "dapagliflozyna", "dapagliflozin", "edistride"],
  },
  Sitagliptinum: {
    kategoria: `${K_CUKRZYCA} (gliptyna)`,
    naCoPomaga: "Obniża poziom cukru we krwi w cukrzycy typu 2, wzmacniając naturalne wydzielanie insuliny po posiłku.",
    jakStosowac: "Doustnie, raz na dobę (w połączeniu z metforminą – dwa razy, z posiłkiem).",
    aliasy: ["januvia", "janumet", "sitagliptyna", "sitagliptin", "velmetia", "xelevia", "ristaben"],
  },
  Linagliptinum: {
    kategoria: `${K_CUKRZYCA} (gliptyna)`,
    naCoPomaga: "Obniża poziom cukru we krwi w cukrzycy typu 2; może być stosowana przy chorobach nerek.",
    jakStosowac: "Doustnie, raz na dobę o dowolnej, stałej porze, niezależnie od posiłku.",
    aliasy: ["trajenta", "jentadueto", "linagliptyna", "linagliptin"],
  },
  Vildagliptinum: {
    kategoria: `${K_CUKRZYCA} (gliptyna)`,
    naCoPomaga: "Obniża poziom cukru we krwi w cukrzycy typu 2.",
    jakStosowac: "Doustnie, zwykle dwa razy na dobę, niezależnie od posiłku.",
    aliasy: ["galvus", "eucreas", "wildagliptyna", "vildagliptin", "vildagliptin zentiva"],
  },
  Semaglutidum: {
    kategoria: `${K_CUKRZYCA} (analog GLP-1)`,
    naCoPomaga:
      "Obniża poziom cukru w cukrzycy typu 2, zmniejsza apetyt i masę ciała oraz ryzyko chorób serca i naczyń.",
    jakStosowac:
      "Wstrzyknięcie podskórne raz w tygodniu, tego samego dnia (Ozempic) lub tabletka raz na dobę rano na czczo, " +
      "popita małą ilością wody, 30 minut przed jedzeniem (Rybelsus).",
    aliasy: ["ozempic", "rybelsus", "semaglutyd", "semaglutide", "wegovy"],
  },
  Dulaglutidum: {
    kategoria: `${K_CUKRZYCA} (analog GLP-1)`,
    naCoPomaga: "Obniża poziom cukru we krwi w cukrzycy typu 2 i zmniejsza ryzyko chorób serca.",
    jakStosowac: "Wstrzyknięcie podskórne raz w tygodniu, tego samego dnia tygodnia, o dowolnej porze.",
    aliasy: ["trulicity", "dulaglutyd", "dulaglutide"],
  },
  Insulinum: {
    kategoria: "Insulina",
    naCoPomaga: "Obniża poziom cukru we krwi w cukrzycy typu 1 i 2, zastępując lub uzupełniając własną insulinę.",
    jakStosowac:
      "Podskórnie, zgodnie z indywidualnym schematem diabetologa; zmieniać miejsca wkłuć i regularnie mierzyć glikemię.",
    aliasy: [
      "insulina",
      "humalog",
      "novorapid",
      "lantus",
      "toujeo",
      "tresiba",
      "apidra",
      "abasaglar",
      "gensulin",
      "polhumin",
      "humulin",
      "fiasp",
      "levemir",
      "mixtard",
    ],
  },
  Levothyroxinum: {
    kategoria: "Hormon tarczycy",
    naCoPomaga: "Uzupełnia brak hormonu tarczycy w niedoczynności tarczycy (np. w chorobie Hashimoto, po operacji).",
    jakStosowac:
      "Doustnie, rano na czczo, co najmniej 30 minut przed śniadaniem, popijając wodą. Leki z żelazem, wapniem " +
      "i magnezem przyjmować kilka godzin później.",
    aliasy: [
      "euthyrox",
      "euthyrox n",
      "letrox",
      "lewotyroksyna",
      "levothyroxine",
      "eltroxin",
      "novothyral",
      "tirosint",
    ],
  },
  Thiamazolum: {
    kategoria: "Lek przeciwtarczycowy",
    naCoPomaga: "Hamuje nadmierną produkcję hormonów tarczycy w nadczynności tarczycy (np. chorobie Gravesa-Basedowa).",
    jakStosowac:
      "Doustnie, po posiłku, popijając wodą. Wymaga kontroli morfologii; gorączkę i ból gardła zgłosić lekarzowi.",
    aliasy: ["thyrozol", "metizol", "tiamazol", "thiamazole"],
  },
  Allopurinolum: {
    kategoria: "Lek na dnę moczanową",
    naCoPomaga: "Obniża stężenie kwasu moczowego we krwi, zapobiegając napadom dny moczanowej i kamicy moczanowej.",
    jakStosowac: "Doustnie, po posiłku, popijając dużą ilością wody (ok. 2 litry płynów na dobę).",
    aliasy: ["milurit", "allupol", "zyloric"],
  },
  Febuxostatum: {
    kategoria: "Lek na dnę moczanową",
    naCoPomaga: "Obniża stężenie kwasu moczowego we krwi u osób z przewlekłą dną moczanową.",
    jakStosowac: "Doustnie, raz na dobę, niezależnie od posiłku.",
    aliasy: ["adenuric", "febuksostat", "febuxostat"],
  },
  Colchicinum: {
    kategoria: "Lek na dnę moczanową",
    naCoPomaga: "Łagodzi ostry napad dny moczanowej i zapobiega kolejnym napadom.",
    jakStosowac:
      "Doustnie, ściśle wg zaleceń lekarza – przedawkowanie jest niebezpieczne. Nie łączyć z sokiem grejpfrutowym.",
    aliasy: ["colchicum dispert", "kolchicyna", "colchicine"],
  },

  /* ---------------------------------------------------- Żołądek, jelita, wątroba */
  Omeprazolum: {
    kategoria: K_IPP,
    naCoPomaga:
      "Leczy zgagę, chorobę refluksową, wrzody żołądka i dwunastnicy; chroni żołądek przy lekach przeciwbólowych.",
    jakStosowac: IPP,
    aliasy: [
      "helicid",
      "bioprazol",
      "omeprazol",
      "polprazol",
      "prilosec",
      "losec",
      "gasec",
      "ortanol",
      "omeprazol galena",
    ],
  },
  Pantoprazolum: {
    kategoria: K_IPP,
    naCoPomaga:
      "Leczy zgagę, chorobę refluksową, wrzody żołądka i dwunastnicy; chroni żołądek przy lekach przeciwbólowych.",
    jakStosowac: IPP,
    aliasy: [
      "controloc",
      "controloc control",
      "pantoprazol",
      "nolpaza",
      "nolpaza control",
      "ozzion",
      "anesteloc",
      "pantoprazol genoptim",
    ],
  },
  Esomeprazolum: {
    kategoria: K_IPP,
    naCoPomaga:
      "Leczy zgagę, chorobę refluksową, wrzody żołądka i dwunastnicy; chroni żołądek przy lekach przeciwbólowych.",
    jakStosowac: IPP,
    aliasy: ["nexium", "emanera", "esomeprazol", "esomeprazole"],
  },
  Lansoprazolum: {
    kategoria: K_IPP,
    naCoPomaga: "Leczy zgagę, chorobę refluksową, wrzody żołądka i dwunastnicy.",
    jakStosowac: IPP,
    aliasy: ["lanzul", "lansoprazol", "lansoprazole"],
  },
  Dexlansoprazolum: {
    kategoria: K_IPP,
    naCoPomaga: "Leczy chorobę refluksową przełyku i zgagę.",
    jakStosowac: "Doustnie, raz na dobę, niezależnie od posiłku; kapsułki połykać w całości.",
    aliasy: ["dexilant", "deksnlansoprazol", "dexlansoprazole"],
  },
  Rabeprazolum: {
    kategoria: K_IPP,
    naCoPomaga: "Leczy chorobę refluksową, zgagę oraz wrzody żołądka i dwunastnicy.",
    jakStosowac: "Doustnie, zwykle raz na dobę rano przed posiłkiem; tabletek nie rozgryzać.",
    aliasy: ["zulbex", "rabeprazol", "rabeprazole", "barole", "pariet"],
  },
  Famotidinum: {
    kategoria: K_IPP,
    naCoPomaga: "Łagodzi zgagę i nadkwaśność, wspomaga leczenie wrzodów żołądka i dwunastnicy.",
    jakStosowac: "Doustnie, zwykle wieczorem przed snem lub doraźnie przy zgadze, popijając wodą.",
    aliasy: ["famotydyna", "famotidine", "quamatel"],
  },
  Mebeverinum: {
    kategoria: "Lek rozkurczowy na jelita",
    naCoPomaga: "Łagodzi ból brzucha, skurcze i wzdęcia w zespole jelita drażliwego.",
    jakStosowac: "Doustnie, ok. 20 minut przed posiłkiem; kapsułki połykać w całości, popijając wodą.",
    aliasy: ["duspatalin", "mebeweryna", "mebeverine"],
  },
  Trimebutinum: {
    kategoria: "Lek regulujący pracę jelit",
    naCoPomaga: "Łagodzi ból brzucha, wzdęcia i zaburzenia rytmu wypróżnień w zespole jelita drażliwego.",
    jakStosowac: "Doustnie, przed posiłkiem, popijając wodą.",
    aliasy: ["debretin", "tribux", "tribux forte", "trimebutyna", "trimebutine"],
  },
  Loperamidum: {
    kategoria: "Lek przeciwbiegunkowy",
    naCoPomaga: "Hamuje ostrą biegunkę, zwalniając pracę jelit.",
    jakStosowac:
      "Doustnie, popijając wodą; dawkę początkową i kolejne po każdym luźnym stolcu wg ulotki. Uzupełniać płyny; " +
      "nie stosować przy gorączce i krwi w stolcu.",
    aliasy: ["stoperan", "laremide", "loperamid", "imodium", "loperamide", "loperamid wzf"],
  },
  Diosmectitum: {
    kategoria: "Lek przeciwbiegunkowy (adsorbent)",
    naCoPomaga: "Łagodzi ostrą biegunkę u dzieci i dorosłych, wiążąc toksyny w jelitach.",
    jakStosowac: "Doustnie, zawartość saszetki rozpuścić w wodzie; przyjmować 2 godziny przed lub po innych lekach.",
    aliasy: ["smecta", "diosmektyt", "diosmectite", "diosmectal"],
  },
  "Saccharomyces boulardii": {
    kategoria: "Probiotyk",
    naCoPomaga: "Zapobiega biegunce w trakcie antybiotykoterapii i wspomaga leczenie ostrej biegunki.",
    jakStosowac: "Doustnie, popijając chłodną wodą; nie popijać gorącymi napojami ani alkoholem.",
    aliasy: ["enterol", "enterol 250", "sacharomyces boulardii", "saccharomyces"],
  },
  Mesalazinum: {
    kategoria: "Lek przeciwzapalny na jelita",
    naCoPomaga:
      "Leczy i zapobiega zaostrzeniom wrzodziejącego zapalenia jelita grubego i choroby Leśniowskiego-Crohna.",
    jakStosowac: "Doustnie lub doodbytniczo, regularnie wg zaleceń gastroenterologa; tabletek nie rozgryzać.",
    aliasy: ["pentasa", "salofalk", "asamax", "mesalazyna", "mesalazine", "mezavant"],
  },
  Lactulosum: {
    kategoria: "Lek przeczyszczający",
    naCoPomaga: "Łagodzi zaparcia; stosowana też w encefalopatii wątrobowej.",
    jakStosowac: "Doustnie, zwykle raz na dobę rano, popijając dużą ilością płynów. Efekt po 1–2 dobach.",
    aliasy: ["duphalac", "laktuloza", "lactulose", "lactulosum"],
  },
  Metoclopramidum: {
    kategoria: "Lek przeciwwymiotny",
    naCoPomaga: "Łagodzi nudności i wymioty, m.in. po zabiegach i w migrenie.",
    jakStosowac: "Doustnie, 30 minut przed posiłkiem, krótkotrwale (do 5 dni).",
    aliasy: ["metoklopramid", "metoclopramide", "metoclopramidum polpharma"],
  },
  Ondansetronum: {
    kategoria: "Lek przeciwwymiotny",
    naCoPomaga: "Zapobiega nudnościom i wymiotom po chemioterapii, radioterapii i operacjach.",
    jakStosowac: "Doustnie lub w postaci rozpuszczającej się w ustach, wg schematu lekarza.",
    aliasy: ["zofran", "ondansetron"],
  },
  Phospholipida: {
    kategoria: "Lek wspomagający pracę wątroby",
    naCoPomaga: "Wspomaga regenerację wątroby, np. w stłuszczeniu wątroby i po uszkodzeniach toksycznych.",
    jakStosowac: "Doustnie, w trakcie posiłku, popijając wodą; kapsułek nie rozgryzać.",
    aliasy: ["essentiale", "essentiale forte", "esseliv", "fosfolipidy", "phospholipids"],
  },
  Ornithinum: {
    kategoria: "Lek wspomagający pracę wątroby",
    naCoPomaga: "Wspomaga wątrobę w usuwaniu amoniaku, np. w stłuszczeniu i chorobach wątroby.",
    jakStosowac: "Doustnie, granulat rozpuścić w szklance wody i wypić po posiłku.",
    aliasy: ["hepatil", "hepa-merz", "ornityna", "ornithine", "hepatil max", "asparaginian ornityny"],
  },

  /* ---------------------------------------------------- Układ oddechowy i alergia */
  Salbutamolum: {
    kategoria: `${K_ASTMA} (doraźny)`,
    naCoPomaga: "Szybko rozszerza oskrzela i przerywa napad duszności w astmie oraz POChP.",
    jakStosowac: WZIEWNY_DORAZNY,
    aliasy: ["ventolin", "salbutamol", "buventol", "aspulmo", "salamol"],
  },
  Fenoterolum: {
    kategoria: `${K_ASTMA} (doraźny)`,
    naCoPomaga: "Szybko rozszerza oskrzela i łagodzi duszność w astmie i POChP; w Berodualu z ipratropium.",
    jakStosowac: WZIEWNY_DORAZNY,
    aliasy: ["berodual", "berodual n", "berotec", "fenoterol"],
  },
  Ipratropium: {
    kategoria: `${K_ASTMA} (rozszerzający oskrzela)`,
    naCoPomaga: "Rozszerza oskrzela i łagodzi duszność, głównie w przewlekłej obturacyjnej chorobie płuc (POChP).",
    jakStosowac: "Wziewnie, regularnie lub doraźnie wg zaleceń lekarza; unikać kontaktu leku z oczami.",
    aliasy: ["atrovent", "atrovent n", "ipratropium", "bromek ipratropium"],
  },
  Budesonidum: {
    kategoria: `${K_ASTMA} (kortykosteroid wziewny)`,
    naCoPomaga:
      "Wycisza przewlekły stan zapalny oskrzeli w astmie i POChP, zapobiegając napadom; w aerozolu do nosa leczy katar alergiczny.",
    jakStosowac: STERYD_WZIEWNY,
    aliasy: [
      "pulmicort",
      "budesonid",
      "budezonid",
      "budesonide",
      "symbicort",
      "miflonide",
      "nebbud",
      "bufomix",
      "budiair",
      "tafen nasal",
      "rhinocort",
    ],
  },
  Beclometasonum: {
    kategoria: `${K_ASTMA} (kortykosteroid wziewny)`,
    naCoPomaga:
      "Zapobiega napadom astmy i zaostrzeniom POChP; w Fostexie połączony z formoterolem rozszerzającym oskrzela.",
    jakStosowac: STERYD_WZIEWNY,
    aliasy: ["fostex", "fostex nexthaler", "clenil", "beklometazon", "beclomethasone", "trimbow", "beclazone"],
  },
  Ciclesonidum: {
    kategoria: `${K_ASTMA} (kortykosteroid wziewny)`,
    naCoPomaga: "Wycisza przewlekły stan zapalny oskrzeli i zapobiega napadom astmy.",
    jakStosowac: "Wziewnie, raz na dobę regularnie, zgodnie z instrukcją inhalatora.",
    aliasy: ["alvesco", "cyklezonid", "ciclesonide"],
  },
  Formoterolum: {
    kategoria: `${K_ASTMA} (długo działający)`,
    naCoPomaga: "Długotrwale rozszerza oskrzela w astmie (zawsze ze sterydem wziewnym) i POChP.",
    jakStosowac: WZIEWNY_STALY,
    aliasy: ["foradil", "oxis", "formoterol", "zafiron", "atimos"],
  },
  Salmeterolum: {
    kategoria: `${K_ASTMA} (długo działający)`,
    naCoPomaga: "Długotrwale rozszerza oskrzela; w Seretide łączony z flutykazonem do stałego leczenia astmy i POChP.",
    jakStosowac: `${WZIEWNY_STALY} Po użyciu preparatu złożonego przepłukać usta.`,
    aliasy: ["serevent", "seretide", "salmeterol", "salmex", "airflusal", "seroflo"],
  },
  Fluticasonum: {
    kategoria: "Kortykosteroid wziewny lub donosowy",
    naCoPomaga:
      "Wycisza stan zapalny dróg oddechowych: w astmie i POChP (wziewnie) oraz w alergicznym nieżycie nosa (donosowo).",
    jakStosowac: `${STERYD_WZIEWNY} Postać donosową stosować regularnie, nawet przy braku objawów.`,
    aliasy: ["flixotide", "flutikazon", "fluticasone", "relvar", "flixonase", "avamys", "nasofan", "flutixon"],
  },
  Mometasonum: {
    kategoria: "Kortykosteroid donosowy i na skórę",
    naCoPomaga: "W aerozolu do nosa leczy alergiczny nieżyt nosa i polipy; w kremie i maści – zapalne choroby skóry.",
    jakStosowac: NOS,
    aliasy: ["nasometin", "nasonex", "elocom", "mometazon", "mometasone"],
  },
  Tiotropium: {
    kategoria: `${K_ASTMA} (długo działający)`,
    naCoPomaga: "Długotrwale rozszerza oskrzela i zmniejsza duszność w POChP; stosowany też w ciężkiej astmie.",
    jakStosowac: "Wziewnie, raz na dobę o tej samej porze, zgodnie z instrukcją inhalatora. Kapsułek nie połykać.",
    aliasy: ["spiriva", "spiriva respimat", "tiotropium", "braltus", "tiotropiowy", "srivasso"],
  },
  Montelukastum: {
    kategoria: "Lek przeciwastmatyczny i przeciwalergiczny",
    naCoPomaga: "Zapobiega napadom astmy (także wysiłkowej) i łagodzi objawy alergicznego nieżytu nosa.",
    jakStosowac:
      "Doustnie, raz na dobę wieczorem; tabletki do żucia przyjmować 1 godzinę przed lub 2 godziny po jedzeniu.",
    aliasy: ["singulair", "asmenol", "montelukast", "montespes", "monkasta", "milukante"],
  },
  Cetirizinum: {
    kategoria: K_ALERGIA,
    naCoPomaga: "Łagodzi objawy alergii: katar sienny, kichanie, łzawienie oczu, swędzenie skóry i pokrzywkę.",
    jakStosowac: ANTYHISTAMINA,
    aliasy: ["zyrtec", "allertec", "amertil", "cetyryzyna", "cetirizine", "alerid", "letizen"],
  },
  Levocetirizinum: {
    kategoria: K_ALERGIA,
    naCoPomaga: "Łagodzi objawy alergii: katar sienny, kichanie, łzawienie oczu i pokrzywkę.",
    jakStosowac: ANTYHISTAMINA,
    aliasy: ["xyzal", "zenaro", "cezera", "lewocetyryzyna", "levocetirizine"],
  },
  Desloratadinum: {
    kategoria: K_ALERGIA,
    naCoPomaga: "Łagodzi objawy alergicznego nieżytu nosa i pokrzywki: katar, kichanie, swędzenie, łzawienie oczu.",
    jakStosowac: ANTYHISTAMINA,
    aliasy: ["aerius", "hitaxa", "jovesto", "desloratadyna", "desloratadine", "dehistar", "aleric deslo"],
  },
  Loratadinum: {
    kategoria: K_ALERGIA,
    naCoPomaga: "Łagodzi objawy alergii: katar sienny, kichanie, łzawienie oczu i pokrzywkę.",
    jakStosowac: ANTYHISTAMINA,
    aliasy: ["claritine", "loratadyna", "loratadine", "flonidan", "aleric"],
  },
  Bilastinum: {
    kategoria: K_ALERGIA,
    naCoPomaga: "Łagodzi objawy alergicznego nieżytu nosa, zapalenia spojówek i pokrzywki.",
    jakStosowac: "Doustnie, raz na dobę, 1 godzinę przed lub 2 godziny po posiłku albo soku owocowym.",
    aliasy: ["clatra", "clatra allergy", "bilaxten", "bilastyna", "bilastine"],
  },
  Fexofenadinum: {
    kategoria: K_ALERGIA,
    naCoPomaga: "Łagodzi objawy kataru siennego i przewlekłej pokrzywki, zwykle bez senności.",
    jakStosowac: "Doustnie, raz na dobę przed posiłkiem, popijając wodą (nie sokiem owocowym).",
    aliasy: ["telfexo", "allegra", "telfast", "feksofenadyna", "fexofenadine"],
  },
  Rupatadinum: {
    kategoria: K_ALERGIA,
    naCoPomaga: "Łagodzi objawy alergicznego nieżytu nosa i pokrzywki.",
    jakStosowac: "Doustnie, raz na dobę; unikać soku grejpfrutowego.",
    aliasy: ["rupafin", "rupatadyna", "rupatadine"],
  },
  Hydroxyzinum: {
    kategoria: "Lek przeciwlękowy i przeciwświądowy",
    naCoPomaga: "Łagodzi niepokój i napięcie, ułatwia zasypianie i zmniejsza swędzenie skóry w alergii.",
    jakStosowac: "Doustnie, zwykle wieczorem; powoduje senność – nie prowadzić pojazdów, nie łączyć z alkoholem.",
    aliasy: ["hydroxyzinum", "hydroksyzyna", "hydroxyzine", "atarax", "hydroxyzinum polpharma"],
  },
  Acetylcysteinum: {
    kategoria: K_KASZEL,
    naCoPomaga: "Rozrzedza gęstą wydzielinę w oskrzelach i ułatwia odkrztuszanie przy mokrym kaszlu.",
    jakStosowac: `${WYKRZTUSNY} Tabletki musujące rozpuścić w szklance wody.`,
    aliasy: ["acc", "acc optima", "acc mini", "fluimucil", "acetylocysteina", "acetylcysteine", "nac"],
  },
  Ambroxolum: {
    kategoria: K_KASZEL,
    naCoPomaga: "Rozrzedza wydzielinę i ułatwia odkrztuszanie w ostrych i przewlekłych chorobach dróg oddechowych.",
    jakStosowac: WYKRZTUSNY,
    aliasy: ["mucosolvan", "flavamed", "ambroksol", "ambroxol", "deflegmin", "mucoangin", "ambrosol"],
  },
  Bromhexinum: {
    kategoria: K_KASZEL,
    naCoPomaga: "Rozrzedza wydzielinę i ułatwia odkrztuszanie przy mokrym kaszlu.",
    jakStosowac: WYKRZTUSNY,
    aliasy: ["flegamina", "bromheksyna", "bromhexine", "bisolvon"],
  },
  Erdosteinum: {
    kategoria: K_KASZEL,
    naCoPomaga: "Rozrzedza wydzielinę i ułatwia odkrztuszanie w ostrym i przewlekłym zapaleniu oskrzeli.",
    jakStosowac: WYKRZTUSNY,
    aliasy: ["erdomed", "erdosteina", "erdosteine"],
  },

  /* ---------------------------------------------------- Antybiotyki, przeciwgrzybicze, przeciwwirusowe */
  Amoxicillinum: {
    kategoria: `${K_ANTYB} (penicylina)`,
    naCoPomaga:
      "Leczy zakażenia bakteryjne: gardła, zatok, ucha, płuc, dróg moczowych i skóry; z kwasem klawulanowym " +
      "(Augmentin, Amoksiklav) działa na więcej bakterii.",
    jakStosowac: `${ANTYBIOTYK} Preparaty z kwasem klawulanowym przyjmować na początku posiłku.`,
    aliasy: [
      "augmentin",
      "amoksiklav",
      "duomox",
      "amoksycylina",
      "amoxicillin",
      "amotaks",
      "ospamox",
      "hiconcil",
      "taromentin",
      "amoxiclav",
    ],
  },
  Phenoxymethylpenicillinum: {
    kategoria: `${K_ANTYB} (penicylina)`,
    naCoPomaga: "Leczy anginę paciorkowcową i inne zakażenia wywołane przez wrażliwe bakterie.",
    jakStosowac: `${ANTYBIOTYK} Najlepiej 1 godzinę przed posiłkiem.`,
    aliasy: ["ospen", "penicylina", "fenoksymetylopenicylina"],
  },
  Cefuroximum: {
    kategoria: `${K_ANTYB} (cefalosporyna)`,
    naCoPomaga: "Leczy zakażenia bakteryjne gardła, zatok, ucha, oskrzeli, płuc, dróg moczowych i boreliozę.",
    jakStosowac: `${ANTYBIOTYK} Przyjmować po posiłku – lepiej się wchłania.`,
    aliasy: ["zinnat", "bioracef", "xorimax", "aksef", "cefuroksym", "cefuroxim", "cefuroxime"],
  },
  Cefaclorum: {
    kategoria: `${K_ANTYB} (cefalosporyna)`,
    naCoPomaga: "Leczy zakażenia bakteryjne dróg oddechowych, ucha, dróg moczowych i skóry.",
    jakStosowac: ANTYBIOTYK,
    aliasy: ["ceclor", "cefaklor", "cefaclor", "vercef"],
  },
  Azithromycinum: {
    kategoria: `${K_ANTYB} (makrolid)`,
    naCoPomaga:
      "Leczy bakteryjne zakażenia dróg oddechowych, zatok, ucha, skóry i niektóre choroby przenoszone drogą płciową.",
    jakStosowac: "Doustnie, raz na dobę o stałej porze, zwykle przez 3 dni – nie przerywać kuracji.",
    aliasy: ["sumamed", "azitrox", "azycyna", "azytromycyna", "azithromycin", "zetamax", "azimycin", "azibiot"],
  },
  Clarithromycinum: {
    kategoria: `${K_ANTYB} (makrolid)`,
    naCoPomaga:
      "Leczy bakteryjne zakażenia dróg oddechowych, zatok, skóry; stosowany w eradykacji Helicobacter pylori.",
    jakStosowac: `${ANTYBIOTYK} Zwykle co 12 godzin.`,
    aliasy: ["klacid", "fromilid", "klarmin", "klarytromycyna", "clarithromycin", "clarithromycin bluefish"],
  },
  Ciprofloxacinum: {
    kategoria: `${K_ANTYB} (fluorochinolon)`,
    naCoPomaga: "Leczy poważniejsze zakażenia bakteryjne, m.in. dróg moczowych, przewodu pokarmowego i kości.",
    jakStosowac: `${ANTYBIOTYK} Nie popijać mlekiem; preparaty z wapniem, magnezem i żelazem przyjmować w odstępie kilku godzin.`,
    aliasy: ["cipronex", "ciprinol", "cyprofloksacyna", "ciprofloxacin", "ciphin"],
  },
  Levofloxacinum: {
    kategoria: `${K_ANTYB} (fluorochinolon)`,
    naCoPomaga: "Leczy poważniejsze zakażenia bakteryjne płuc, zatok, dróg moczowych i prostaty.",
    jakStosowac: `${ANTYBIOTYK} Preparaty z wapniem, magnezem i żelazem przyjmować w odstępie co najmniej 2 godzin; unikać słońca.`,
    aliasy: ["levoxa", "lewofloksacyna", "levofloxacin", "tavanic", "oftaquix"],
  },
  Clindamycinum: {
    kategoria: `${K_ANTYB} (linkozamid)`,
    naCoPomaga: "Leczy zakażenia bakteryjne skóry, kości, zębów, dróg oddechowych i narządów płciowych.",
    jakStosowac: `${ANTYBIOTYK} Popijać pełną szklanką wody, w pozycji stojącej. Zgłaszać ciężką biegunkę.`,
    aliasy: ["dalacin", "dalacin c", "klindamycyna", "clindamycin", "clindamycin mip", "klimicin"],
  },
  Sulfamethoxazolum: {
    kategoria: `${K_ANTYB} (sulfonamid z trimetoprimem)`,
    naCoPomaga: "Leczy zakażenia dróg moczowych, oddechowych i przewodu pokarmowego.",
    jakStosowac: `${ANTYBIOTYK} Pić dużo płynów; unikać intensywnego słońca.`,
    aliasy: ["biseptol", "kotrimoksazol", "co-trimoxazole", "bactrim", "sulfametoksazol"],
  },
  Nitrofurantoinum: {
    kategoria: "Lek przeciwbakteryjny na drogi moczowe",
    naCoPomaga: "Leczy i zapobiega niepowikłanym zakażeniom dolnych dróg moczowych (zapalenie pęcherza).",
    jakStosowac: "Doustnie, w trakcie posiłku lub z mlekiem, w równych odstępach czasu przez cały zalecony okres.",
    aliasy: ["nitrofurantoina", "nitrofurantoin", "furadantin"],
  },
  Furazidinum: {
    kategoria: "Lek przeciwbakteryjny na drogi moczowe",
    naCoPomaga: "Leczy zakażenia dolnych dróg moczowych, np. zapalenie pęcherza moczowego.",
    jakStosowac: "Doustnie, w trakcie posiłku, popijając dużą ilością wody, przez cały zalecony okres.",
    aliasy: ["furagina", "furaginum", "urofuraginum", "urofuragina", "furazydyna", "furazidin", "uro-furagin"],
  },
  Fosfomycinum: {
    kategoria: "Lek przeciwbakteryjny na drogi moczowe",
    naCoPomaga: "Leczy ostre, niepowikłane zapalenie pęcherza moczowego u kobiet – zwykle jedną dawką.",
    jakStosowac:
      "Doustnie, jednorazowo na pusty żołądek, najlepiej wieczorem po opróżnieniu pęcherza; saszetkę rozpuścić w wodzie.",
    aliasy: ["monural", "fosfomycyna", "fosfomycin"],
  },
  Doxycyclinum: {
    kategoria: `${K_ANTYB} (tetracyklina)`,
    naCoPomaga:
      "Leczy zakażenia bakteryjne dróg oddechowych, boreliozę, trądzik i niektóre choroby przenoszone drogą płciową.",
    jakStosowac: `${ANTYBIOTYK} Popijać pełną szklanką wody w pozycji stojącej, nie kłaść się 30 minut; unikać słońca i nie popijać mlekiem.`,
    aliasy: ["doxycyclinum", "doksycyklina", "doxycycline", "unidox", "doxypharm", "doxycyclinum polpharma"],
  },
  Metronidazolum: {
    kategoria: "Lek przeciwbakteryjny i przeciwpierwotniakowy",
    naCoPomaga: "Leczy zakażenia bakteriami beztlenowymi i pierwotniakami, np. rzęsistkowicę i zakażenia pochwy.",
    jakStosowac: `${ANTYBIOTYK} Bezwzględnie nie pić alkoholu w trakcie leczenia i 2 doby po nim.`,
    aliasy: ["metronidazol", "metronidazole", "flagyl", "rozex"],
  },
  Fluconazolum: {
    kategoria: "Lek przeciwgrzybiczy",
    naCoPomaga: "Leczy zakażenia grzybicze (drożdżakowe) pochwy, jamy ustnej, skóry i narządów wewnętrznych.",
    jakStosowac: "Doustnie, raz na dobę lub jednorazowo (grzybica pochwy), niezależnie od posiłku.",
    aliasy: ["flumycon", "flukonazol", "fluconazole", "mycosyst", "diflucan"],
  },
  Aciclovirum: {
    kategoria: "Lek przeciwwirusowy",
    naCoPomaga: "Leczy zakażenia wirusem opryszczki i półpaśca, skraca czas trwania objawów.",
    jakStosowac:
      "Doustnie, kilka razy na dobę w równych odstępach; leczenie rozpocząć jak najwcześniej, pić dużo płynów.",
    aliasy: ["heviran", "zovirax", "acyklowir", "aciclovir", "virolex"],
  },

  /* ---------------------------------------------------- Układ nerwowy i psychiatria */
  Diazepamum: {
    kategoria: "Lek przeciwlękowy i uspokajający (benzodiazepina)",
    naCoPomaga: "Łagodzi silny lęk i napięcie, rozluźnia mięśnie; stosowany też w drgawkach i zespole odstawiennym.",
    jakStosowac: BENZO,
    aliasy: ["relanium", "diazepam", "diazepan", "neorelium", "relsed", "diazepamum", "diazepam desitin"],
  },
  Alprazolamum: {
    kategoria: "Lek przeciwlękowy (benzodiazepina)",
    naCoPomaga: "Łagodzi stany lękowe i napady paniki.",
    jakStosowac: BENZO,
    aliasy: ["xanax", "xanax sr", "afobam", "alprox", "alprazolam", "zomiren", "neurol"],
  },
  Lorazepamum: {
    kategoria: "Lek przeciwlękowy (benzodiazepina)",
    naCoPomaga: "Łagodzi silny lęk i napięcie, np. przed zabiegami, oraz krótkotrwale bezsenność związaną z lękiem.",
    jakStosowac: BENZO,
    aliasy: ["lorafen", "lorazepam"],
  },
  Zolpidemum: {
    kategoria: "Lek nasenny",
    naCoPomaga: "Ułatwia zasypianie w krótkotrwałej bezsenności.",
    jakStosowac:
      "Doustnie, tuż przed snem, gdy można spać co najmniej 7–8 godzin; nie dłużej niż 4 tygodnie. Nie łączyć z alkoholem.",
    aliasy: ["stilnox", "nasen", "hypnogen", "zolpidem"],
  },
  Sertralinum: {
    kategoria: K_DEPR,
    naCoPomaga: "Leczy depresję, zaburzenia lękowe, napady paniki, zaburzenia obsesyjno-kompulsyjne i PTSD.",
    jakStosowac: DEPRESJA,
    aliasy: ["zoloft", "asentra", "sertagen", "setaloft", "sertralina", "sertralin", "stimuloton", "aleval"],
  },
  Escitalopramum: {
    kategoria: K_DEPR,
    naCoPomaga: "Leczy depresję, zaburzenia lękowe, napady paniki i fobię społeczną.",
    jakStosowac: DEPRESJA,
    aliasy: ["lexapro", "cipralex", "elicea", "escitil", "mozarin", "depralin", "escitalopram"],
  },
  Citalopramum: {
    kategoria: K_DEPR,
    naCoPomaga: "Leczy depresję i napady paniki.",
    jakStosowac: DEPRESJA,
    aliasy: ["cital", "citalec", "aurex", "citalopram", "cytalopram", "cipramil"],
  },
  Paroxetinum: {
    kategoria: K_DEPR,
    naCoPomaga: "Leczy depresję, zaburzenia lękowe, napady paniki, fobię społeczną i zaburzenia obsesyjno-kompulsyjne.",
    jakStosowac: `${DEPRESJA} Najlepiej rano, z posiłkiem.`,
    aliasy: ["parogen", "rexetin", "seroxat", "paroksetyna", "paroxetine", "xetanor"],
  },
  Fluoxetinum: {
    kategoria: K_DEPR,
    naCoPomaga: "Leczy depresję, bulimię i zaburzenia obsesyjno-kompulsyjne.",
    jakStosowac: `${DEPRESJA} Najlepiej rano.`,
    aliasy: ["prozac", "bioxetin", "fluoksetyna", "fluoxetine", "fluoxetin", "seronil"],
  },
  Venlafaxinum: {
    kategoria: K_DEPR,
    naCoPomaga: "Leczy depresję oraz zaburzenia lękowe (uogólnione, napady paniki, fobię społeczną).",
    jakStosowac: `${DEPRESJA} Kapsułki o przedłużonym uwalnianiu przyjmować z posiłkiem, połykać w całości.`,
    aliasy: ["venlectine", "efectin", "efectin er", "velaxin", "velafax", "wenlafaksyna", "venlafaxine", "alventa"],
  },
  Duloxetinum: {
    kategoria: K_DEPR,
    naCoPomaga: "Leczy depresję i zaburzenia lękowe; łagodzi ból w neuropatii cukrzycowej.",
    jakStosowac: `${DEPRESJA} Kapsułki połykać w całości.`,
    aliasy: ["cymbalta", "dulsevia", "depratal", "duloksetyna", "duloxetine"],
  },
  Trazodonum: {
    kategoria: K_DEPR,
    naCoPomaga: "Leczy depresję, zwłaszcza przebiegającą z lękiem i bezsennością.",
    jakStosowac: "Doustnie, zwykle wieczorem przed snem, po posiłku. Nie odstawiać nagle bez konsultacji z lekarzem.",
    aliasy: ["trittico", "trittico cr", "trittico xr", "trazodon", "trazodone"],
  },
  Mirtazapinum: {
    kategoria: K_DEPR,
    naCoPomaga: "Leczy depresję, zwłaszcza z bezsennością i brakiem apetytu.",
    jakStosowac: "Doustnie, raz na dobę wieczorem przed snem. Może zwiększać apetyt i senność.",
    aliasy: ["mirtor", "remirta", "mirzaten", "mirtazapina", "mirtazapine", "esprital", "remeron"],
  },
  Mianserinum: {
    kategoria: K_DEPR,
    naCoPomaga: "Leczy depresję, zwłaszcza z niepokojem i zaburzeniami snu.",
    jakStosowac: "Doustnie, zwykle wieczorem przed snem. Powoduje senność.",
    aliasy: ["lerivon", "miansan", "mianseryna", "mianserin"],
  },
  Quetiapinum: {
    kategoria: K_PSYCH,
    naCoPomaga: "Leczy schizofrenię i chorobę afektywną dwubiegunową; wspomaga leczenie depresji.",
    jakStosowac: PSYCHOZA,
    aliasy: ["seroquel", "ketrel", "kventiax", "ketipinor", "kwetiapina", "quetiapine"],
  },
  Olanzapinum: {
    kategoria: K_PSYCH,
    naCoPomaga: "Leczy schizofrenię i epizody manii w chorobie afektywnej dwubiegunowej.",
    jakStosowac: PSYCHOZA,
    aliasy: ["zyprexa", "zolafren", "olanzapina", "olanzapine", "zalasta"],
  },
  Risperidonum: {
    kategoria: K_PSYCH,
    naCoPomaga: "Leczy schizofrenię, manię w chorobie dwubiegunowej oraz zaburzenia zachowania z agresją.",
    jakStosowac: PSYCHOZA,
    aliasy: ["rispolept", "risperidon", "rysperydon", "risperidone", "rispolux", "torendo"],
  },
  Aripiprazolum: {
    kategoria: K_PSYCH,
    naCoPomaga: "Leczy schizofrenię i epizody manii w chorobie afektywnej dwubiegunowej.",
    jakStosowac: PSYCHOZA,
    aliasy: ["abilify", "aripiprazol", "aripiprazole", "explemed", "aripiprazol zentiva"],
  },
  Pregabalinum: {
    kategoria: "Lek przeciwpadaczkowy i na ból neuropatyczny",
    naCoPomaga: "Łagodzi ból neuropatyczny (np. w cukrzycy, półpaścu), leczy uogólnione zaburzenia lękowe i padaczkę.",
    jakStosowac: `${PADACZKA} Może powodować senność i zawroty głowy.`,
    aliasy: ["lyrica", "pregabalina", "pregabalin", "pregabalin pfizer", "egzysta"],
  },
  Gabapentinum: {
    kategoria: "Lek przeciwpadaczkowy i na ból neuropatyczny",
    naCoPomaga: "Łagodzi ból neuropatyczny (np. po półpaścu) i wspomaga leczenie padaczki.",
    jakStosowac: `${PADACZKA} Leki zobojętniające kwas żołądkowy przyjmować 2 godziny wcześniej.`,
    aliasy: ["neurontin", "gabagamma", "gabapentyna", "gabapentin"],
  },
  Carbamazepinum: {
    kategoria: K_PADACZKA,
    naCoPomaga: "Zapobiega napadom padaczkowym; łagodzi nerwoból nerwu trójdzielnego, stabilizuje nastrój.",
    jakStosowac: `${PADACZKA} Najlepiej w trakcie lub po posiłku; tabletek retard nie rozgryzać.`,
    aliasy: ["finlepsin", "finlepsin retard", "tegretol", "amizepin", "karbamazepina", "carbamazepine", "neurotop"],
  },
  "Acidum valproicum": {
    kategoria: K_PADACZKA,
    naCoPomaga: "Zapobiega napadom padaczkowym i stabilizuje nastrój w chorobie afektywnej dwubiegunowej.",
    jakStosowac: `${PADACZKA} Najlepiej w trakcie posiłku. Lek szkodliwy dla płodu – kobiety muszą stosować skuteczną antykoncepcję.`,
    aliasy: ["depakine", "depakine chrono", "convulex", "orfiril", "walproinian", "kwas walproinowy", "valproate"],
  },
  Lamotriginum: {
    kategoria: K_PADACZKA,
    naCoPomaga: "Zapobiega napadom padaczkowym oraz epizodom depresji w chorobie afektywnej dwubiegunowej.",
    jakStosowac: `${PADACZKA} Dawkę zwiększa się stopniowo; każdą wysypkę natychmiast zgłosić lekarzowi.`,
    aliasy: ["lamitrin", "lamitrin s", "lamictal", "lamotrygina", "lamotrigine", "lamotrix"],
  },
  Levetiracetamum: {
    kategoria: K_PADACZKA,
    naCoPomaga: "Zapobiega napadom padaczkowym (częściowym i uogólnionym).",
    jakStosowac: `${PADACZKA} Zwykle dwa razy na dobę, niezależnie od posiłku.`,
    aliasy: ["keppra", "lewetyracetam", "levetiracetam"],
  },
  Topiramatum: {
    kategoria: K_PADACZKA,
    naCoPomaga: "Zapobiega napadom padaczkowym i napadom migreny.",
    jakStosowac: `${PADACZKA} Pić dużo płynów (ryzyko kamicy nerkowej).`,
    aliasy: ["topamax", "topiramat", "topiramate", "epiramat"],
  },
  Donepezilum: {
    kategoria: "Lek na otępienie (chorobę Alzheimera)",
    naCoPomaga:
      "Spowalnia narastanie objawów otępienia w chorobie Alzheimera (pamięć, orientacja, codzienne funkcjonowanie).",
    jakStosowac: "Doustnie, raz na dobę wieczorem przed snem.",
    aliasy: ["aricept", "yasnal", "donepezil", "donepezyl"],
  },
  Memantinum: {
    kategoria: "Lek na otępienie (chorobę Alzheimera)",
    naCoPomaga: "Łagodzi objawy umiarkowanego i ciężkiego otępienia w chorobie Alzheimera.",
    jakStosowac: "Doustnie, raz na dobę o stałej porze, niezależnie od posiłku. Dawkę zwiększa się stopniowo.",
    aliasy: ["ebixa", "memantyna", "memantine", "polmatine", "marixino"],
  },
  Rivastigminum: {
    kategoria: "Lek na otępienie (chorobę Alzheimera i Parkinsona)",
    naCoPomaga: "Łagodzi objawy otępienia w chorobie Alzheimera i chorobie Parkinsona.",
    jakStosowac:
      "Plaster raz na dobę na czystą, suchą skórę pleców, ramienia lub klatki piersiowej, zmieniając miejsce; " +
      "kapsułki – z posiłkiem rano i wieczorem.",
    aliasy: ["exelon", "nimvastid", "rywastygmina", "rivastigmine", "evertas"],
  },
  Ropinirolum: {
    kategoria: "Lek na chorobę Parkinsona",
    naCoPomaga: "Łagodzi objawy choroby Parkinsona (sztywność, spowolnienie, drżenie) i zespołu niespokojnych nóg.",
    jakStosowac: "Doustnie, o stałych porach, najlepiej z posiłkiem; może powodować nagłą senność.",
    aliasy: ["requip", "ropinirol", "ropinirole", "polpix", "ropinirol sandoz"],
  },
  Levodopum: {
    kategoria: "Lek na chorobę Parkinsona",
    naCoPomaga: "Uzupełnia niedobór dopaminy i łagodzi objawy choroby Parkinsona (sztywność, spowolnienie, drżenie).",
    jakStosowac:
      "Doustnie, o stałych porach, najlepiej 30 minut przed lub 1 godzinę po posiłku (białko osłabia działanie).",
    aliasy: ["madopar", "nakom", "sinemet", "lewodopa", "levodopa", "duodopa", "stalevo"],
  },
  Betahistinum: {
    kategoria: "Lek na zawroty głowy",
    naCoPomaga: "Łagodzi zawroty głowy, szumy uszne i niedosłuch w chorobie Ménière'a.",
    jakStosowac: PO_POSILKU,
    aliasy: ["betaserc", "polvertic", "betahistyna", "betahistine", "microser"],
  },
  Sumatriptanum: {
    kategoria: "Lek przeciwmigrenowy (tryptan)",
    naCoPomaga: "Przerywa napad migreny z aurą lub bez.",
    jakStosowac:
      "Doustnie, jak najszybciej po wystąpieniu bólu migrenowego; drugą dawkę można przyjąć najwcześniej po 2 godzinach.",
    aliasy: ["imigran", "sumamigren", "sumatriptan"],
  },
  Methylphenidatum: {
    kategoria: "Lek na ADHD",
    naCoPomaga: "Poprawia koncentrację i zmniejsza nadpobudliwość u dzieci i dorosłych z ADHD.",
    jakStosowac: "Doustnie, rano (ewentualnie też w południe); nie przyjmować wieczorem – utrudnia zasypianie.",
    aliasy: ["concerta", "medikinet", "ritalin", "metylofenidat", "methylphenidate"],
  },

  /* ---------------------------------------------------- Inne często realizowane recepty */
  Tamsulosinum: {
    kategoria: "Lek na przerost prostaty",
    naCoPomaga: "Ułatwia oddawanie moczu i zmniejsza parcie w łagodnym rozroście gruczołu krokowego.",
    jakStosowac: "Doustnie, raz na dobę po śniadaniu (lub tym samym posiłku), kapsułkę połykać w całości.",
    aliasy: ["omnic", "omnic ocas", "tamsulosyna", "tamsulosin", "fokusin", "bazetham"],
  },
  Finasteridum: {
    kategoria: "Lek na przerost prostaty",
    naCoPomaga: "Zmniejsza rozmiar powiększonego gruczołu krokowego i ułatwia oddawanie moczu.",
    jakStosowac: "Doustnie, raz na dobę, niezależnie od posiłku. Efekt po kilku miesiącach regularnego stosowania.",
    aliasy: ["proscar", "finaster", "finasteryd", "finasteride", "penester"],
  },
  Solifenacinum: {
    kategoria: "Lek na pęcherz nadreaktywny",
    naCoPomaga: "Zmniejsza nagłe parcie na mocz, częstomocz i nietrzymanie moczu z parcia.",
    jakStosowac: "Doustnie, raz na dobę, popijając wodą, niezależnie od posiłku.",
    aliasy: ["vesicare", "solifenacyna", "solifenacin"],
  },
  Sildenafilum: {
    kategoria: "Lek na zaburzenia erekcji",
    naCoPomaga:
      "Ułatwia uzyskanie i utrzymanie erekcji przy pobudzeniu seksualnym; w innych dawkach leczy nadciśnienie płucne.",
    jakStosowac:
      "Doustnie, ok. 1 godzinę przed aktywnością seksualną, nie częściej niż raz na dobę. Nie łączyć z azotanami.",
    aliasy: ["viagra", "maxigra", "sildenafil", "inventum", "revatio"],
  },
  Prednisonum: {
    kategoria: "Lek przeciwzapalny (kortykosteroid)",
    naCoPomaga:
      "Silnie hamuje stan zapalny i reakcje alergiczne, m.in. w astmie, chorobach reumatycznych i autoimmunologicznych.",
    jakStosowac: KORTYKOSTEROID,
    aliasy: ["encorton", "prednizon", "prednisone", "prednisonum polfa"],
  },
  Methylprednisolonum: {
    kategoria: "Lek przeciwzapalny (kortykosteroid)",
    naCoPomaga: "Silnie hamuje stan zapalny i reakcje alergiczne, m.in. w chorobach reumatycznych, alergiach i astmie.",
    jakStosowac: KORTYKOSTEROID,
    aliasy: ["medrol", "metypred", "metyloprednizolon", "methylprednisolone", "solu-medrol", "depo-medrol"],
  },
  Dexamethasonum: {
    kategoria: "Lek przeciwzapalny (kortykosteroid)",
    naCoPomaga:
      "Silnie hamuje stan zapalny, obrzęk i reakcje alergiczne; stosowany m.in. w onkologii i ciężkich alergiach.",
    jakStosowac: KORTYKOSTEROID,
    aliasy: ["dexaven", "pabi-dexamethason", "deksametazon", "dexamethasone", "dexamethasone krka"],
  },
  Methotrexatum: {
    kategoria: "Lek immunosupresyjny i przeciwnowotworowy",
    naCoPomaga:
      "Hamuje stan zapalny w reumatoidalnym zapaleniu stawów, łuszczycy i innych chorobach autoimmunologicznych.",
    jakStosowac:
      "W chorobach reumatycznych ZWYKLE RAZ W TYGODNIU, w ustalonym dniu – nie codziennie. Zwykle z kwasem foliowym; " +
      "wymaga kontroli krwi.",
    aliasy: ["metotreksat", "methotrexat", "methotrexate", "trexan", "metoject", "ebetrexat"],
  },
  Colecalciferolum: {
    kategoria: "Witamina D",
    naCoPomaga: "Uzupełnia niedobór witaminy D, wspiera zdrowie kości i zapobiega krzywicy oraz osteoporozie.",
    jakStosowac:
      "Doustnie, w trakcie posiłku zawierającego tłuszcz – lepiej się wchłania. Dawkę ustala lekarz lub ulotka.",
    aliasy: ["vigantol", "vigantoletten", "d-vitum", "witamina d", "cholekalcyferol", "juvit d3", "devikap"],
  },
  "Acidum alendronicum": {
    kategoria: "Lek na osteoporozę",
    naCoPomaga: "Wzmacnia kości i zmniejsza ryzyko złamań w osteoporozie.",
    jakStosowac:
      "Raz w tygodniu rano na czczo, popijając pełną szklanką zwykłej wody, w pozycji stojącej lub siedzącej; " +
      "nie kłaść się i nie jeść przez co najmniej 30 minut.",
    aliasy: ["fosamax", "alendronian", "alendronate", "ostemax 70", "ostolek"],
  },
  "Kalii chloridum": {
    kategoria: "Suplement potasu",
    naCoPomaga: "Uzupełnia niedobór potasu, np. przy stosowaniu leków moczopędnych.",
    jakStosowac: "Doustnie, w trakcie lub po posiłku, popijając dużą ilością wody; tabletek nie rozgryzać.",
    aliasy: ["kaldyum", "kalipoz", "kalipoz prolongatum", "chlorek potasu", "potas"],
  },
  "Acidum folicum": {
    kategoria: "Witamina (kwas foliowy)",
    naCoPomaga: "Uzupełnia niedobór kwasu foliowego; zapobiega wadom cewy nerwowej u płodu i leczy niedokrwistość.",
    jakStosowac: "Doustnie, raz na dobę, popijając wodą.",
    aliasy: ["kwas foliowy", "folik", "acidum folicum richter"],
  },
  Latanoprostum: {
    kategoria: "Lek przeciwjaskrowy (krople do oczu)",
    naCoPomaga: "Obniża ciśnienie w gałce ocznej w jaskrze i nadciśnieniu ocznym, chroniąc nerw wzrokowy.",
    jakStosowac: `${OKO} Zwykle 1 kropla wieczorem.`,
    aliasy: ["xalatan", "latanoprost", "xaloptic", "monoprost", "xalacom"],
  },
  Timololum: {
    kategoria: "Lek przeciwjaskrowy (krople do oczu)",
    naCoPomaga: "Obniża ciśnienie w gałce ocznej w jaskrze i nadciśnieniu ocznym.",
    jakStosowac: OKO,
    aliasy: ["timolol", "timoptic", "cusimolol", "nyolol"],
  },
};

/** Klucz porównawczy aliasu: małe litery, bez polskich znaków i bez separatorów („No-Spa” → „nospa”). */
export function aliasKey(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("ł", "l")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Hasła przypisane w słowniku do więcej niż jednej substancji (powinna być pusta – pilnują tego testy). */
export const ALIAS_CONFLICTS: readonly string[] = [];

const ALIAS_INDEX: ReadonlyMap<string, string> = (() => {
  const index = new Map<string, string>();
  const conflicts = ALIAS_CONFLICTS as string[];
  for (const [substance, entry] of Object.entries(SUBSTANCES)) {
    for (const name of [substance, ...entry.aliasy]) {
      const key = aliasKey(name);
      const existing = index.get(key);
      if (existing && existing !== substance) conflicts.push(`${name}: ${existing} / ${substance}`);
      else index.set(key, substance);
    }
  }
  return index;
})();

/** Liczba haseł w słowniku (marki + polskie nazwy + nazwy łacińskie). */
export const ALIAS_COUNT = ALIAS_INDEX.size;

/** Lista łacińskich substancji czynnych obsługiwanych przez słownik. */
export const KNOWN_SUBSTANCES: readonly string[] = Object.keys(SUBSTANCES);

/**
 * Zamienia polską pisownię nazwy substancji na przybliżoną łacińską (INN):
 *   atorwastatyna → atorvastatinum, paracetamol → paracetamolum, diazepan → diazepamum,
 *   lewotyroksyna → levothyroxinum, semaglutyd → semaglutidum.
 * Zwraca null, gdy słowo nie wygląda na polską nazwę substancji (brak pasującej końcówki).
 */
export function normalizePolishSubstance(word: string): string | null {
  let w = aliasKey(word);
  if (w.length < 5 || /\d/.test(w)) return null;
  if (w.endsWith("um")) return w;
  // Transliteracja polskiej pisowni na łacińską.
  w = w
    .replaceAll("ks", "x")
    .replaceAll("w", "v")
    .replace(/(?<=[^aeiouy])y(?=[^aeiouy]|$)/g, "i")
    .replace(/(?<=[aeiou])y(?=[aeiou])/g, "i");
  const rules: [RegExp, string][] = [
    [/(?:yna|ina|yn|in)$/, "inum"],
    [/(?:yd|id)$/, "idum"],
    [/ol$/, "olum"],
    [/(?:an|am)$/, "amum"],
    [/(?:yl|il)$/, "ilum"],
    [/(?:at)$/, "atum"],
    [/(?:on)$/, "onum"],
    [/(?:ex|ax|ix|ox)$/, "$&um"],
  ];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(w)) return w.replace(pattern, replacement);
  }
  return null;
}

/**
 * Rdzeń łacińskiej nazwy używany w zapytaniu ILIKE – bez końcówki fleksyjnej, aby
 * „Metforminum” znalazło też „Metformini hydrochloridum”, a „Bisoprololum” – „Bisoprololi fumaras”.
 */
export function substanceStem(latin: string): string {
  const folded = latin.toLowerCase().trim();
  if (folded.includes(" ")) return folded.replace(/um$/, "");
  return folded.replace(/(?:um|us|a|i)$/, "");
}

export type AliasKind = "brand" | "polish";

export interface AliasResolution {
  /** Łacińska substancja czynna z bazy MZ, np. „Paracetamolum”. */
  substance: string;
  /** Fragment zapytania, który został rozpoznany. */
  matched: string;
  /** „brand” – trafienie w słownik; „polish” – reguła polskich końcówek. */
  kind: AliasKind;
}

/**
 * Rozpoznaje substancję czynną na podstawie zapytania użytkownika.
 * Kolejność: całe zapytanie w słowniku → pojedyncze słowa w słowniku → reguły polskich końcówek.
 */
export function resolveAlias(query: string): AliasResolution | null {
  const whole = ALIAS_INDEX.get(aliasKey(query));
  if (whole) return { substance: whole, matched: query.trim(), kind: "brand" };

  const words = query.split(/[\s,;/+]+/).filter((w) => aliasKey(w).length >= 3);
  for (const word of words) {
    const hit = ALIAS_INDEX.get(aliasKey(word));
    if (hit) return { substance: hit, matched: word, kind: "brand" };
  }
  for (const word of words) {
    const latin = normalizePolishSubstance(word);
    if (!latin) continue;
    const known = ALIAS_INDEX.get(latin);
    const substance = known ?? latin.charAt(0).toUpperCase() + latin.slice(1);
    return { substance, matched: word, kind: "polish" };
  }
  return null;
}

/**
 * Kandydaci łacińscy do wyszukiwania fuzzy: surowe słowa zapytania oraz ich
 * transliteracja z polskiego (np. „atorwastayna” → „atorvastainum”).
 */
export function fuzzyCandidates(query: string): string[] {
  const out = new Set<string>();
  const whole = aliasKey(query);
  if (whole.length >= 4) out.add(query.toLowerCase().replaceAll("ł", "l").normalize("NFD").replace(/\p{M}/gu, ""));
  for (const word of query.split(/[\s,;/+]+/)) {
    const key = aliasKey(word);
    if (key.length < 4) continue;
    out.add(key);
    const latin = normalizePolishSubstance(word);
    if (latin) out.add(latin);
  }
  return [...out].slice(0, 3);
}

/* -------------------------------------------------------------------------- */
/*  Opisy substancji: na co pomaga i jak stosować                             */
/* -------------------------------------------------------------------------- */

/** Małe litery bez polskich znaków (spacje i separatory zachowane – potrzebne do granic słów). */
function foldForMatch(value: string): string {
  return value.toLowerCase().replaceAll("ł", "l").normalize("NFD").replace(/\p{M}/gu, "");
}

const SUBSTANCE_STEMS: readonly { substance: string; stem: string }[] = Object.keys(SUBSTANCES).map((substance) => ({
  substance,
  stem: foldForMatch(substanceStem(substance)),
}));

/**
 * Dopasowuje nazwę substancji z obwieszczenia MZ (np. „Metformini hydrochloridum”,
 * „tert-Butylamini perindoprilum + Amlodipinum”) do klucza słownika.
 * Rdzeń musi zaczynać się na granicy słowa; przy kilku trafieniach wygrywa pierwsza
 * substancja w nazwie, a przy remisie – dłuższy (bardziej szczegółowy) rdzeń.
 */
export function matchKnownSubstance(substancjaCzynna: string): string | null {
  const folded = foldForMatch(substancjaCzynna);
  let best: { substance: string; pos: number; len: number } | null = null;
  for (const { substance, stem } of SUBSTANCE_STEMS) {
    let pos = folded.indexOf(stem);
    while (pos > 0 && /[a-z]/.test(folded.charAt(pos - 1))) pos = folded.indexOf(stem, pos + 1);
    if (pos < 0) continue;
    if (!best || pos < best.pos || (pos === best.pos && stem.length > best.len)) {
      best = { substance, pos, len: stem.length };
    }
  }
  return best?.substance ?? null;
}

type RouteKind =
  | "doustnie"
  | "oczy"
  | "uszy"
  | "nos"
  | "wziewnie"
  | "iniekcja"
  | "przezskornie"
  | "skora"
  | "doodbytniczo"
  | "dopochwowo"
  | "jama_ustna";

/** Droga podania opisana we wskazówce słownika (null – wskazówka mieszana, np. „doustnie lub doodbytniczo”). */
function entryRouteKind(jakStosowac: string): RouteKind | null {
  if (/^Doustnie(?! lub)/.test(jakStosowac)) return "doustnie";
  if (/^Wziewnie/.test(jakStosowac)) return "wziewnie";
  if (/^Donosowo/.test(jakStosowac)) return "nos";
  if (/^Do worka spojówkowego/.test(jakStosowac)) return "oczy";
  if (/^Podskórnie/.test(jakStosowac)) return "iniekcja";
  return null;
}

interface RouteHint {
  /** Droga podania rozpoznana z postaci farmaceutycznej. */
  kind: RouteKind;
  text: string;
}

/** Reguły rozpoznawania drogi podania na podstawie postaci z obwieszczenia MZ (kolejność ma znaczenie). */
const ROUTE_RULES: readonly [RegExp, RouteHint][] = [
  [/oczu|spojówk/, { kind: "oczy", text: "Zakraplać do worka spojówkowego zgodnie z zaleceniem lekarza." }],
  [/uszu|uszn/, { kind: "uszy", text: "Zakraplać do przewodu słuchowego zgodnie z zaleceniem lekarza." }],
  [/do nosa|donos/, { kind: "nos", text: "Stosować donosowo zgodnie z zaleceniem lekarza i ulotką." }],
  [/inhal|wziew|nebuliz|\binh\b/, { kind: "wziewnie", text: "Stosować wziewnie zgodnie z instrukcją inhalatora." }],
  [
    /wstrz|\binj\b|infuz|implant|amp\./,
    { kind: "iniekcja", text: "Podawać we wstrzyknięciu lub wlewie zgodnie z zaleceniem lekarza lub pielęgniarki." },
  ],
  [
    /transderm|plaster/,
    {
      kind: "przezskornie",
      text: "Naklejać na czystą, suchą, nieowłosioną skórę, zmieniając miejsce zgodnie z ulotką.",
    },
  ],
  [/maść|krem|żel|skór|piana/, { kind: "skora", text: "Stosować na skórę zgodnie z zaleceniem lekarza i ulotką." }],
  [/czop|doodbyt|wlewk/, { kind: "doodbytniczo", text: "Stosować doodbytniczo zgodnie z zaleceniem lekarza." }],
  [
    /dopochw|glob/,
    { kind: "dopochwowo", text: "Stosować dopochwowo, najlepiej wieczorem przed snem, zgodnie z zaleceniem lekarza." },
  ],
  [
    /podjęzyk|podpolicz|jamie ustnej/,
    {
      kind: "jama_ustna",
      text: "Pozostawić w jamie ustnej (pod językiem lub przy policzku) do rozpuszczenia – nie połykać w całości.",
    },
  ],
  [/dojel/, { kind: "doustnie", text: "Przyjmować doustnie, połykając w całości bez rozgryzania, popijając wodą." }],
  [
    /przedł|zmodyfik|retard/,
    { kind: "doustnie", text: "Przyjmować doustnie, połykając w całości bez rozgryzania i kruszenia, popijając wodą." },
  ],
  [
    /tabl|kaps|draż|granulat|syrop|doustn|zawiesin|proszek do sporz|liofilizat/,
    { kind: "doustnie", text: "Przyjmować doustnie, popijając wodą zgodnie z zaleceniem lekarza." },
  ],
];

/** Rozpoznaje drogę podania z postaci farmaceutycznej (null, gdy postać jest nieznana). */
export function routeHint(postac: string): RouteHint | null {
  const folded = postac.toLowerCase();
  if (!folded.trim()) return null;
  for (const [pattern, hint] of ROUTE_RULES) if (pattern.test(folded)) return hint;
  return null;
}

const ALL_INDICATIONS = /^we wszystkich zarejestrowanych wskazaniach/i;
const MAX_INDICATION_LENGTH = 280;

/** Opis zastępczy dla substancji spoza słownika – na podstawie wskazania refundacyjnego i postaci. */
export function fallbackDescription(wskazanie: string, postac: string): SubstanceDescription {
  const indication = wskazanie.trim().replace(/[.;\s]+$/, "");
  let naCoPomaga: string;
  if (!indication || ALL_INDICATIONS.test(indication)) {
    naCoPomaga =
      "Lek jest refundowany we wszystkich zarejestrowanych wskazaniach – szczegółowe zastosowanie opisuje ulotka; " +
      "w razie wątpliwości zapytaj lekarza lub farmaceutę.";
  } else {
    const short =
      indication.length > MAX_INDICATION_LENGTH
        ? `${indication.slice(0, MAX_INDICATION_LENGTH).replace(/[\s,;]+\S*$/, "")}…`
        : indication;
    naCoPomaga = `Stosowany m.in. w: ${short.replaceAll(";", ",")}.`;
  }
  return {
    kategoria: "Lek refundowany",
    naCoPomaga,
    jakStosowac: routeHint(postac)?.text ?? "Stosować zgodnie z zaleceniem lekarza i ulotką dołączoną do opakowania.",
    zrodlo: "ogolny",
    substancja: null,
  };
}

/** Minimalny zestaw pól leku potrzebny do zbudowania opisu. */
export interface DescribableDrug {
  nazwa: string;
  substancja_czynna: string;
  postac: string;
  wskazanie: string;
}

/**
 * Zwraca opis „na co pomaga i jak stosować” dla leku z wykazu.
 *
 * Kolejność: substancja czynna z obwieszczenia → nazwa handlowa (słownik marek) → opis zastępczy
 * z pól `wskazanie` i `postac`. Gdy wskazówka ze słownika dotyczy innej drogi podania niż postać leku
 * (np. słownik: „Doustnie…”, a postać: krople do oczu, inhalator, wstrzyknięcie), wskazówka pochodzi z postaci.
 */
export function describeDrug(drug: DescribableDrug): SubstanceDescription {
  let substance = matchKnownSubstance(drug.substancja_czynna);
  if (!substance) {
    const viaBrand = resolveAlias(drug.nazwa);
    if (viaBrand?.kind === "brand" && viaBrand.substance in SUBSTANCES) substance = viaBrand.substance;
  }
  const entry = substance ? SUBSTANCES[substance] : undefined;
  if (!substance || !entry) return fallbackDescription(drug.wskazanie ?? "", drug.postac ?? "");

  const route = routeHint(drug.postac ?? "");
  const entryKind = entryRouteKind(entry.jakStosowac);
  const jakStosowac = route && entryKind && route.kind !== entryKind ? route.text : entry.jakStosowac;
  const naCoPomaga = drug.substancja_czynna.includes("+")
    ? `${entry.naCoPomaga} Preparat złożony – zawiera także inną substancję czynną (${drug.substancja_czynna}).`
    : entry.naCoPomaga;
  return { kategoria: entry.kategoria, naCoPomaga, jakStosowac, zrodlo: "slownik", substancja: substance };
}

/** Opis substancji ze słownika po nazwie łacińskiej, marce lub polskiej nazwie (null, gdy brak). */
export function substanceInfo(query: string): SubstanceInfo | null {
  const substance = KNOWN_SUBSTANCES.includes(query) ? query : resolveAlias(query)?.substance;
  const entry = substance ? SUBSTANCES[substance] : undefined;
  return entry ? { kategoria: entry.kategoria, naCoPomaga: entry.naCoPomaga, jakStosowac: entry.jakStosowac } : null;
}
