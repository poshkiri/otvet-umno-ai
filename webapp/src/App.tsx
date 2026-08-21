import {
  ArrowLeftIcon,
  CameraIcon,
  CheckCircledIcon,
  ChevronRightIcon,
  ChatBubbleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  FileTextIcon,
  Link2Icon,
  HomeIcon,
  LockClosedIcon,
  PaperPlaneIcon,
  PersonIcon,
  QuestionMarkCircledIcon,
  ReaderIcon,
  ReloadIcon,
  SpeakerLoudIcon,
  StarIcon,
} from "@radix-ui/react-icons";
import { AnimatePresence, motion } from "motion/react";
import { FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, miniAppApi, type AccessPayload, type SessionPayload } from "./api";
import { telegramWebApp } from "./telegram";

type View = "home" | "history" | "profile" | "working" | "result" | "limit" | "error";

interface ResultSection {
  title: string;
  body: string;
}

type HistoryItem = SessionPayload["history"][number];
type InfoPageId = "privacy" | "terms" | "tariffs" | "support";

interface InfoSection {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
}

interface InfoPageContent {
  eyebrow: string;
  title: string;
  intro: string;
  sections: InfoSection[];
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

const DEMO_RESULT = [
  "Что на фото",
  "Это упаковка гречки. На лицевой стороне указаны вес, способ приготовления и основные свойства продукта.",
  "",
  "Что важно",
  "Проверь срок годности, целостность упаковки и состав на обратной стороне. Если пришлёшь её фотографию, я разберу всё подробнее.",
  "",
  "Как использовать",
  "Промой крупу, залей водой в пропорции примерно 1 к 2 и вари на слабом огне до готовности.",
].join("\n");

const DEMO_TEXT_RESULT = [
  "Короткий ответ",
  "Инфляция — это общий рост цен, из-за которого со временем на одну и ту же сумму можно купить меньше товаров и услуг.",
  "",
  "Простой пример",
  "Если год назад продукт стоил 100 рублей, а сейчас 110, его цена выросла на 10%. На инфляцию смотрят по изменению цен сразу на большую корзину товаров.",
].join("\n");

const DEMO_HISTORY: HistoryItem[] = [
  {
    id: -1,
    source: "Решите неравенство",
    result: "Решим неравенство по шагам и проверим область допустимых значений.",
    flow: "analyze",
    createdAt: new Date().toISOString(),
  },
  {
    id: -2,
    source: "Что такое инфляция?",
    result: "Объяснение инфляции простыми словами с понятным примером.",
    flow: "analyze",
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  },
];

const DEMO_SESSION: SessionPayload = {
  user: { firstName: "Max" },
  access: { remaining: 5, label: "5 запросов", plan: "free" },
  botUsername: "OtvetUmnoAI_bot",
  payments: {
    plategaEnabled: true,
    packages: [
      { id: "start", title: "50 запросов", credits: 50, rubles: 199 },
      { id: "plus", title: "200 запросов", credits: 200, rubles: 649 },
      { id: "pro", title: "500 запросов", credits: 500, rubles: 1_490 },
    ],
    recent: [],
  },
  history: DEMO_HISTORY,
};

const INFO_PAGES: Record<InfoPageId, InfoPageContent> = {
  privacy: {
    eyebrow: "Документы",
    title: "Политика конфиденциальности",
    intro: "Настоящая политика описывает, какие данные обрабатывает сервис Пойми AI, для каких целей они нужны и как пользователь может управлять ими.",
    sections: [
      {
        title: "1. Общие положения",
        paragraphs: [
          "Политика действует при использовании Telegram-бота Пойми AI (@OtvetUmnoAI_bot), его страниц с документами и связанных функций. Администрация сервиса обрабатывает только те данные, которые необходимы для выполнения запросов, учёта доступа, оплаты, поддержки и безопасности.",
          "Используя сервис и добровольно отправляя сообщение или файл, пользователь подтверждает, что ознакомился с этой политикой. Если пользователь не согласен с условиями, ему следует прекратить использование сервиса.",
        ],
      },
      {
        title: "2. Какие данные обрабатываются",
        bullets: [
          "Данные Telegram-профиля: числовой Telegram ID, имя, фамилия и username, если они переданы Telegram.",
          "Пользовательский контент: текстовые запросы, фотографии, документы, голосовые сообщения и инструкции к ним.",
          "Результаты обработки, история обращений, использованные лимиты и сведения о выбранном тарифе.",
          "Данные об оплате: идентификатор операции, сумма, валюта, выбранный пакет, статус начисления и возврата.",
          "Технические сведения: дата и время действий, события ошибок, данные устройства и соединения, необходимые для защиты и стабильной работы страниц сервиса.",
        ],
        paragraphs: ["Пойми AI не запрашивает и не хранит полный номер банковской карты, CVC-код, пароль от банка или код подтверждения из SMS. Эти данные обрабатываются платёжной системой и банком на их стороне."],
      },
      {
        title: "3. Откуда поступают данные",
        paragraphs: [
          "Основная информация поступает от самого пользователя и от Telegram при открытии бота. Сведения об оплате поступают от Telegram Stars или подключённого платёжного провайдера после создания и обработки операции.",
          "Не отправляйте в сервис чужие персональные данные без законного основания и разрешения их владельца. Перед отправкой документа или фотографии рекомендуется скрыть лишние реквизиты, адреса, номера телефонов и другие конфиденциальные сведения.",
        ],
      },
      {
        title: "4. Цели обработки",
        bullets: [
          "Выполнение запросов и формирование ответов, анализа файлов и изображений.",
          "Создание и изменение изображений по команде пользователя.",
          "Сохранение истории, учёт бесплатных и купленных AI-баллов и срока действия Plus.",
          "Создание платежа, подтверждение оплаты, начисление услуги и обработка возврата.",
          "Ответ на обращения в поддержку, поиск ошибок и восстановление ошибочно не начисленной покупки.",
          "Предотвращение злоупотреблений, защита сервиса, диагностика и улучшение качества работы.",
        ],
      },
      {
        title: "5. Передача и обработчики данных",
        paragraphs: [
          "Для работы сервиса данные могут передаваться только в необходимом объёме техническим исполнителям: Telegram обеспечивает интерфейс бота, AI-провайдер обрабатывает запросы, Render размещает приложение, а Telegram Stars и Platega обеспечивают оплату.",
          "Передача также возможна по требованию закона, для защиты прав пользователя и сервиса либо с отдельного согласия пользователя. Администрация не продаёт персональные данные и не передаёт их для сторонней рекламы.",
        ],
      },
      {
        title: "6. Срок хранения и удаление",
        paragraphs: [
          "Данные хранятся, пока это необходимо для работы аккаунта, исполнения оплаченных услуг, поддержки, безопасности и учёта операций. Срок может отличаться для истории запросов, технических журналов и платёжных записей.",
          "Пользователь может запросить удаление своих данных через @PoymiAI_support, указав Telegram ID. Перед удалением администрация вправе проверить принадлежность аккаунта. Платёжные и технические сведения могут сохраняться дольше, если это необходимо для исполнения закона, рассмотрения спора или защиты от мошенничества.",
        ],
      },
      {
        title: "7. Защита данных",
        paragraphs: [
          "Для защиты применяются разграничение доступа, секретные ключи окружения, журналирование операций и проверка платёжных уведомлений. Доступ к административным функциям ограничен разрешёнными Telegram ID.",
          "Ни один способ передачи и хранения данных в интернете не гарантирует абсолютную безопасность. Пользователь должен самостоятельно защищать свой Telegram-аккаунт и не передавать третьим лицам коды, пароли и платёжные данные.",
        ],
      },
      {
        title: "8. Права пользователя",
        bullets: [
          "Уточнить, какие данные связаны с его Telegram ID.",
          "Попросить исправить неточные сведения.",
          "Запросить удаление данных, если их дальнейшее хранение не требуется по закону или для исполнения обязательств.",
          "Отозвать добровольное согласие, прекратив использование сервиса и направив обращение в поддержку.",
        ],
      },
      {
        title: "9. Ограничения и данные несовершеннолетних",
        paragraphs: [
          "Сервис не предназначен для передачи паспортных данных, медицинских тайн, банковских реквизитов и иной чувствительной информации без необходимости. Пользователь самостоятельно оценивает, какие сведения можно отправить для выполнения запроса.",
          "Несовершеннолетним рекомендуется пользоваться платными функциями с согласия законного представителя.",
        ],
      },
      {
        title: "10. Изменения и контакты",
        paragraphs: [
          "Политика может обновляться при изменении функций, законодательства или используемых исполнителей. Новая редакция действует с даты, указанной на этой странице.",
          "По вопросам обработки и удаления данных напишите в Telegram: @PoymiAI_support. Поддержка доступна всем пользователям независимо от тарифа.",
        ],
      },
    ],
  },
  terms: {
    eyebrow: "Документы",
    title: "Пользовательское соглашение",
    intro: "Настоящее соглашение регулирует использование Telegram-бота Пойми AI, бесплатных функций, подписки Plus и разовых пакетов AI-баллов.",
    sections: [
      {
        title: "1. Общие положения",
        paragraphs: [
          "Сервис предоставляет доступ к цифровым функциям через Telegram-бота @OtvetUmnoAI_bot. Отправка команды, сообщения или файла означает принятие настоящего соглашения и политики конфиденциальности.",
          "Администрация сервиса Пойми AI предоставляет функциональность в объёме, доступном на момент обращения. Актуальные тарифы, лимиты и контакты опубликованы на постоянных страницах сервиса и внутри бота.",
        ],
      },
      {
        title: "2. Возможности сервиса",
        paragraphs: ["Пойми AI может отвечать на текстовые и голосовые вопросы, анализировать фотографии, скриншоты и документы, помогать с учёбой и текстами, а также создавать и изменять изображения."],
        bullets: [
          "Бесплатный доступ предоставляется в пределах стартового лимита.",
          "Plus предоставляет AI-баллы и лимит изображений на выбранный срок.",
          "Разовые пакеты пополняют баланс AI-баллов и не требуют подписки.",
        ],
      },
      {
        title: "3. Регистрация и доступ",
        paragraphs: [
          "Отдельная регистрация не требуется: учётная запись создаётся по Telegram ID пользователя. Пользователь отвечает за безопасность своего Telegram-аккаунта и за действия, совершённые через него.",
          "Передавать доступ к административным функциям, пытаться обходить лимиты, вмешиваться в работу сервиса или использовать автоматические средства для перегрузки запрещено.",
        ],
      },
      {
        title: "4. Особенности ответов AI",
        paragraphs: [
          "Ответы и изображения создаются автоматически и могут быть неполными, неточными или устаревшими. Сервис не заменяет врача, юриста, финансового консультанта, экстренную службу или другого профильного специалиста.",
          "Пользователь обязан самостоятельно проверять важную информацию до принятия решения. Администрация не гарантирует конкретный результат, абсолютную точность, постоянную доступность или соответствие ответа субъективным ожиданиям.",
        ],
      },
      {
        title: "5. Правила допустимого использования",
        bullets: [
          "Не отправлять незаконные материалы и чужие персональные данные без законного основания.",
          "Не использовать сервис для мошенничества, угроз, вреда, нарушения авторских прав или обхода закона.",
          "Не создавать запрещённый контент 18+, материалы с эксплуатацией несовершеннолетних или иной контент, запрещённый применимым законодательством.",
          "Не выдавать автоматически созданный ответ за подтверждённое заключение специалиста.",
        ],
        paragraphs: ["При нарушении правил запрос может быть отклонён, а доступ временно или постоянно ограничен без компенсации использованной части услуги."],
      },
      {
        title: "6. Пользовательский контент и права",
        paragraphs: [
          "Пользователь сохраняет права на законно принадлежащие ему материалы. Отправляя контент, он разрешает технически обработать его только в объёме, необходимом для выполнения команды, обеспечения работы и безопасности сервиса.",
          "Пользователь подтверждает, что имеет право отправлять материалы и запрашивать их обработку. Обозначения, интерфейс и программный код Пойми AI нельзя копировать или распространять без разрешения правообладателя.",
        ],
      },
      {
        title: "7. Платные услуги и начисление",
        paragraphs: [
          "До оплаты пользователь видит название продукта, состав, срок, цену и валюту. Оплата может проводиться через Telegram Stars или доступный платёжный способ Platega. Банковские реквизиты вводятся на стороне платёжного провайдера.",
          "Услуга считается предоставленной после подтверждения платежа и начисления Plus или AI-баллов на Telegram ID плательщика. Обычный ответ, голос, PDF или анализ фото расходует 1 балл; новая картинка - 2 балла; изменение фотографии - 3 балла.",
          "Plus на 1 месяц продлевается автоматически каждые 30 дней, пока пользователь не отключит продление. Планы на 3, 6 и 12 месяцев оплачиваются один раз и не продлеваются автоматически. Разовые AI-баллы не сгорают.",
        ],
      },
      {
        title: "8. Возвраты и спорные операции",
        paragraphs: [
          "Если оплата подтверждена, но услуга не начислена, пользователь должен обратиться в @PoymiAI_support и сообщить Telegram ID, ID операции, дату, сумму и описание проблемы. Поддержка доступна всем пользователям без подписки.",
          "Возврат рассматривается индивидуально с учётом статуса платежа, причины обращения и уже использованного объёма цифровой услуги. При подтверждённой технической ошибке администрация восстанавливает доступ, повторно начисляет покупку либо оформляет возврат доступным способом.",
          "Обращение рекомендуется направить сразу после обнаружения проблемы. Настоящие условия не ограничивают права пользователя, которые не могут быть ограничены применимым законодательством.",
        ],
      },
      {
        title: "9. Доступность и ограничение ответственности",
        paragraphs: [
          "Сервис предоставляется по принципу «как есть». Возможны технические работы, задержки Telegram, AI-провайдера, хостинга, банка или платёжной системы. Администрация старается восстановить работу и корректно начислить оплаченные услуги, но не отвечает за недоступность внешних платформ вне своего контроля.",
          "При нарушении соглашения, попытке мошенничества или угрозе безопасности доступ может быть ограничен. Пользователь может обратиться в поддержку для проверки решения.",
        ],
      },
      {
        title: "10. Изменение условий и контакты",
        paragraphs: [
          "Функции, лимиты, цены и соглашение могут обновляться. Уже оплаченный продукт сохраняет объём и срок, указанные пользователю при покупке, если иное не требуется законом или не согласовано с пользователем.",
          "Новая редакция действует с даты публикации. По вопросам оплаты, доступа и правил напишите в Telegram: @PoymiAI_support.",
        ],
      },
    ],
  },
  tariffs: {
    eyebrow: "Оплата",
    title: "Тарифы и цены",
    intro: "Все цены показываются до оплаты. Скрытых списаний нет.",
    sections: [
      {
        title: "Бесплатно",
        bullets: ["5 AI-запросов после первого запуска.", "1 пробное создание изображения."],
      },
      {
        title: "Plus в Telegram Stars",
        bullets: [
          "1 месяц: 399 Stars, 100 AI-баллов, до 20 картинок. Автопродление каждые 30 дней можно отключить.",
          "3 месяца: 999 Stars, 360 AI-баллов, до 75 картинок. Разовая оплата.",
          "6 месяцев: 1799 Stars, 780 AI-баллов, до 165 картинок. Разовая оплата.",
          "12 месяцев: 2999 Stars, 1800 AI-баллов, до 360 картинок. Разовая оплата.",
        ],
      },
      {
        title: "Разовые пакеты в Telegram",
        bullets: ["50 запросов — 199 Stars.", "200 запросов — 699 Stars.", "500 запросов — 1599 Stars."],
      },
      {
        title: "Как списываются запросы",
        paragraphs: ["Обычный ответ, голос, PDF или разбор фотографии расходует 1 AI-балл. Создание новой картинки расходует 2 балла, изменение фотографии - 3 балла. Для изображений также действует отдельный лимит Plus. Разовые AI-баллы не сгорают."],
      },
      {
        title: "Оплата в рублях через Platega",
        bullets: ["50 AI-баллов - 199 ₽.", "200 AI-баллов - 649 ₽.", "500 AI-баллов - 1490 ₽."],
        paragraphs: ["Оплата картой или через СБП станет доступна после согласования проекта и подключения рабочего доступа Platega. Итоговая цена всегда показывается до перехода к оплате."],
      },
      {
        title: "Для проверки проекта",
        paragraphs: ["Код согласования: Platega test. После выдачи рабочих доступов эта строка будет удалена."],
      },
    ],
  },
  support: {
    eyebrow: "Помощь",
    title: "Поддержка",
    intro: "Поддержка доступна всем пользователям, даже если подписки нет. Поможем, если запросы не начислились, платёж завис или в сервисе появилась ошибка.",
    sections: [
      {
        title: "Как обратиться",
        paragraphs: ["Напишите напрямую в Telegram: @PoymiAI_support. Поддержка доступна всем пользователям независимо от наличия подписки."],
      },
      {
        title: "Кто может написать",
        paragraphs: ["Обращение может отправить любой пользователь: бесплатный, платный или ещё не оплативший тариф."],
      },
      {
        title: "Что указать",
        bullets: ["Telegram ID или username.", "ID платежа из раздела «Мои покупки».", "Что произошло и когда.", "Скриншот ошибки, если он есть."],
      },
      {
        title: "Важно",
        paragraphs: ["Никому не отправляйте код из SMS, пароль, данные карты или секретные ключи. Для проверки платежа поддержке достаточно ID операции."],
      },
    ],
  },
};

export default function App() {
  const telegram = useMemo(() => telegramWebApp(), []);
  const isDemo = !telegram?.initData;
  const isMobilePreview = new URLSearchParams(window.location.search).has("mobile-preview");
  const [view, setView] = useState<View>("home");
  const [previewUrl, setPreviewUrl] = useState("/app/product-grocery.jpg");
  const [resultPreview, setResultPreview] = useState("");
  const [selectedFile, setSelectedFile] = useState<File>();
  const [access, setAccess] = useState<AccessPayload>({ remaining: 5, label: "5 запросов", plan: "free" });
  const [history, setHistory] = useState<HistoryItem[]>(isDemo ? DEMO_HISTORY : []);
  const [botUsername, setBotUsername] = useState("OtvetUmnoAI_bot");
  const [session, setSession] = useState<SessionPayload | undefined>(isDemo ? DEMO_SESSION : undefined);
  const [paymentBusy, setPaymentBusy] = useState("");
  const [paymentNotice, setPaymentNotice] = useState("");
  const [result, setResult] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [followUps, setFollowUps] = useState<Array<{ question: string; answer: string }>>([]);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [workingText, setWorkingText] = useState("Готовлю понятный ответ");
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const recognition = useRef<SpeechRecognitionLike | undefined>(undefined);

  const applySession = (session: SessionPayload) => {
    setSession(session);
    setAccess(session.access);
    setBotUsername(session.botUsername);
    setHistory(session.history);
  };

  const checkPendingPayment = async () => {
    if (!telegram?.initData) return;
    const transactionId = window.localStorage.getItem("poymi-pending-payment");
    if (!transactionId) return;
    setPaymentBusy(transactionId);
    try {
      const payment = await miniAppApi.plategaPayment(telegram.initData, transactionId);
      setAccess(payment.access);
      if (payment.status === "confirmed") {
        window.localStorage.removeItem("poymi-pending-payment");
        setPaymentNotice("Оплата подтверждена. Запросы уже начислены.");
        await refreshSession();
      } else if (payment.status === "canceled" || payment.status === "chargebacked") {
        window.localStorage.removeItem("poymi-pending-payment");
        setPaymentNotice("Платёж не завершён. Можно попробовать ещё раз.");
      } else {
        setPaymentNotice("Платёж ещё обрабатывается. Проверим снова через несколько секунд.");
      }
    } catch (reason) {
      setPaymentNotice(reason instanceof Error ? reason.message : "Не удалось проверить платёж");
    } finally {
      setPaymentBusy("");
    }
  };

  const showError = (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : "Что-то пошло не так";
    setError(message);
    setView(reason instanceof ApiError && reason.code === "LIMIT_REACHED" ? "limit" : "error");
    telegram?.HapticFeedback?.notificationOccurred("error");
  };

  useEffect(() => {
    telegram?.ready();
    telegram?.expand();
    telegram?.setHeaderColor?.("#f7f8f7");
    telegram?.setBackgroundColor?.("#f7f8f7");
    if (!telegram?.initData) return;
    miniAppApi.session(telegram.initData).then(applySession).catch((reason: unknown) => showError(reason));
    if (new URLSearchParams(window.location.search).has("payment")) void checkPendingPayment();
  }, [telegram]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void checkPendingPayment(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [telegram]);

  useEffect(() => () => {
    recognition.current?.stop();
    if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const refreshSession = async () => {
    if (!telegram?.initData) return;
    applySession(await miniAppApi.session(telegram.initData));
  };

  const chooseFile = (file?: File) => {
    if (!file) return;
    if (!file.type.match(/^image\/(jpeg|png|webp)$/)) {
      showError(new Error("Выбери фотографию JPG, PNG или WebP."));
      return;
    }
    if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    telegram?.HapticFeedback?.impactOccurred("light");
  };

  const analyze = async () => {
    if (!selectedFile && !isDemo) {
      fileInput.current?.click();
      return;
    }
    setWorkingText("Разбираю фотографию");
    setView("working");
    telegram?.HapticFeedback?.impactOccurred("medium");
    try {
      if (isDemo) {
        await wait(1_100);
        setResult(DEMO_RESULT);
        setConversationId("demo");
        setAccess({ ...access, remaining: Math.max(0, (access.remaining ?? 5) - 1), label: "4 запроса" });
      } else {
        const response = await miniAppApi.analyze(telegram!.initData, selectedFile!, question.trim() || undefined);
        setResult(response.result);
        setConversationId(response.conversationId);
        setAccess(response.access);
        await refreshSession();
      }
      setResultPreview(previewUrl);
      setFollowUps([]);
      setQuestion("");
      setView("result");
      telegram?.HapticFeedback?.notificationOccurred("success");
    } catch (reason) {
      showError(reason);
    }
  };

  const askGeneral = async (text: string) => {
    setWorkingText("Готовлю понятный ответ");
    setView("working");
    setSending(true);
    try {
      if (isDemo) {
        await wait(900);
        setResult(DEMO_TEXT_RESULT);
        setAccess({ ...access, remaining: Math.max(0, (access.remaining ?? 5) - 1), label: "4 запроса" });
      } else {
        const response = await miniAppApi.ask(telegram!.initData, text);
        setResult(response.result);
        setAccess(response.access);
        await refreshSession();
      }
      setResultPreview("");
      setConversationId("");
      setFollowUps([]);
      setQuestion("");
      setView("result");
      telegram?.HapticFeedback?.notificationOccurred("success");
    } catch (reason) {
      showError(reason);
    } finally {
      setSending(false);
    }
  };

  const submitHome = async (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (selectedFile) {
      await analyze();
      return;
    }
    if (text) await askGeneral(text);
  };

  const startVoiceInput = () => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      showError(new Error("Голосовой ввод недоступен на этом устройстве. Можно отправить голосовое сообщение прямо в боте."));
      return;
    }
    recognition.current?.stop();
    const next = new Recognition();
    next.lang = "ru-RU";
    next.continuous = false;
    next.interimResults = false;
    next.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      if (transcript) setQuestion(transcript);
      telegram?.HapticFeedback?.notificationOccurred("success");
    };
    next.onerror = () => setError("Не удалось распознать голос. Попробуй ещё раз или напиши вопрос.");
    next.onend = () => setListening(false);
    recognition.current = next;
    setListening(true);
    next.start();
    telegram?.HapticFeedback?.impactOccurred("light");
  };

  const askFollowUp = async (event: FormEvent) => {
    event.preventDefault();
    await submitFollowUp(question);
  };

  const submitFollowUp = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setQuestion("");
    try {
      const response = isDemo
        ? { result: "Разберём это по шагам. Сначала выделим главное, затем проверим детали.", access }
        : conversationId
          ? await miniAppApi.followUp(telegram!.initData, conversationId, trimmed)
          : await miniAppApi.ask(telegram!.initData, trimmed);
      setFollowUps((items) => [...items, { question: trimmed, answer: response.result }]);
      setAccess(response.access);
      if (!isDemo) await refreshSession();
      telegram?.HapticFeedback?.notificationOccurred("success");
    } catch (reason) {
      showError(reason);
    } finally {
      setSending(false);
    }
  };

  const openHistoryItem = (item: HistoryItem) => {
    setResult(item.result);
    setResultPreview(item.id === -1 ? "/app/math-problem.jpg" : "");
    setConversationId("");
    setFollowUps([]);
    setView("result");
  };

  const openPlans = () => telegram?.openTelegramLink(`https://t.me/${botUsername}?start=miniapp_plus`);

  const buyWithPlatega = async (packageId: string) => {
    if (!telegram?.initData || paymentBusy) return;
    setPaymentBusy(packageId);
    setPaymentNotice("");
    try {
      const payment = await miniAppApi.createPlategaPayment(telegram.initData, packageId);
      window.localStorage.setItem("poymi-pending-payment", payment.transactionId);
      if (telegram.openLink) telegram.openLink(payment.url);
      else window.open(payment.url, "_blank", "noopener,noreferrer");
    } catch (reason) {
      setPaymentNotice(reason instanceof Error ? reason.message : "Не удалось открыть оплату");
    } finally {
      setPaymentBusy("");
    }
  };

  const resetHome = () => {
    setView("home");
    setError("");
    setResult("");
    setResultPreview("");
    setConversationId("");
    setFollowUps([]);
  };

  const infoPageId = infoPageFromPath(window.location.pathname);
  if (infoPageId) return <InfoPage pageId={infoPageId} />;

  return (
    <div className={`app ${isMobilePreview ? "mobile-preview" : ""}`}>
      <AnimatePresence mode="wait">
        {view === "home" && (
          <HomeView
            access={access}
            history={history}
            previewUrl={previewUrl}
            selectedFile={selectedFile}
            question={question}
            listening={listening}
            onQuestion={setQuestion}
            onChoosePhoto={() => fileInput.current?.click()}
            onAnalyze={analyze}
            onSubmit={submitHome}
            onVoice={startVoiceInput}
            onOpenHistory={openHistoryItem}
            onHistory={() => setView("history")}
            onProfile={() => setView("profile")}
          />
        )}
        {view === "history" && (
          <HistoryView
            history={history}
            onOpen={openHistoryItem}
            onHome={resetHome}
            onProfile={() => setView("profile")}
          />
        )}
        {view === "profile" && session && (
          <ProfileView
            session={session}
            busy={paymentBusy}
            notice={paymentNotice}
            onHome={resetHome}
            onHistory={() => setView("history")}
            onStars={openPlans}
            onBuy={buyWithPlatega}
            onCheck={checkPendingPayment}
          />
        )}
        {view === "working" && <WorkingView previewUrl={selectedFile ? previewUrl : ""} text={workingText} />}
        {view === "result" && (
          <ResultView
            access={access}
            previewUrl={resultPreview}
            result={result}
            followUps={followUps}
            question={question}
            sending={sending}
            onQuestion={setQuestion}
            onSubmit={askFollowUp}
            onQuickAction={submitFollowUp}
            onBack={resetHome}
          />
        )}
        {view === "limit" && <MessageView title="Запросы закончились" text={error} action="Посмотреть Plus" onAction={openPlans} onBack={resetHome} />}
        {view === "error" && <MessageView title="Не получилось" text={error} action="Вернуться" onAction={resetHome} onBack={resetHome} />}
      </AnimatePresence>
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        onChange={(event) => chooseFile(event.target.files?.[0])}
      />
    </div>
  );
}

function HomeView({ access, history, previewUrl, selectedFile, question, listening, onQuestion, onChoosePhoto, onAnalyze, onSubmit, onVoice, onOpenHistory, onHistory, onProfile }: {
  access: AccessPayload;
  history: HistoryItem[];
  previewUrl: string;
  selectedFile?: File;
  question: string;
  listening: boolean;
  onQuestion: (value: string) => void;
  onChoosePhoto: () => void;
  onAnalyze: () => void;
  onSubmit: (event: FormEvent) => void;
  onVoice: () => void;
  onOpenHistory: (item: HistoryItem) => void;
  onHistory: () => void;
  onProfile: () => void;
}) {
  const latest = history[0];
  return (
    <motion.main className="home-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <header className="topbar">
        <Brand />
        <span className="access">{access.remaining === null ? "Безлимит" : access.label}<i /></span>
      </header>

      <section className="home-content">
        <h1>Покажите или спросите</h1>
        <div className="photo-action">
          <img src={previewUrl} alt={selectedFile ? "Выбранная фотография" : "Пример фотографии товара"} />
          <button type="button" onClick={selectedFile ? onAnalyze : onChoosePhoto}>
            <CameraIcon />
            Разобрать фото
          </button>
        </div>

        <form className="home-composer" onSubmit={onSubmit}>
          <button className="attach-button" type="button" onClick={onChoosePhoto} aria-label="Прикрепить фотографию"><Link2Icon /></button>
          <input value={question} onChange={(event) => onQuestion(event.target.value)} placeholder={selectedFile ? "Что хотите узнать о фото?" : "Напишите вопрос"} aria-label="Ваш вопрос" />
          <button className={`voice-button ${listening ? "is-listening" : ""}`} type="button" onClick={onVoice} aria-label="Задать вопрос голосом"><SpeakerLoudIcon /></button>
          <button className="send-button" type="submit" disabled={!question.trim() && !selectedFile} aria-label="Отправить"><PaperPlaneIcon /></button>
        </form>
        <p className="example">Фото, документ, задача или обычный вопрос</p>

        <section className="recent-section">
          <div className="section-heading">
            <h2>Продолжить</h2>
            <button type="button" onClick={onHistory}>Вся история <ChevronRightIcon /></button>
          </div>
          {latest ? (
            <button type="button" className="recent-row" onClick={() => onOpenHistory(latest)}>
              <span className="recent-icon"><ClockIcon /></span>
              <span><strong>{historyTitle(latest)}</strong><small>{latest.source}</small></span>
              <ChevronRightIcon />
            </button>
          ) : <p className="empty-history">Первый ответ появится здесь.</p>}
        </section>
      </section>
      <BottomNav active="home" onHome={() => undefined} onHistory={onHistory} onProfile={onProfile} />
    </motion.main>
  );
}

function HistoryView({ history, onOpen, onHome, onProfile }: {
  history: HistoryItem[];
  onOpen: (item: HistoryItem) => void;
  onHome: () => void;
  onProfile: () => void;
}) {
  return (
    <motion.main className="history-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <header className="section-topbar"><div><span>Ваши ответы</span><h1>История</h1></div><ClockIcon /></header>
      <div className="history-scroll">
        {history.length ? history.map((item) => (
          <button type="button" className="history-card" key={item.id} onClick={() => onOpen(item)}>
            <span className="history-type">{item.source.toLowerCase().includes("фото") ? <CameraIcon /> : <ChatBubbleIcon />}</span>
            <span className="history-copy"><strong>{historyTitle(item)}</strong><span>{item.source}</span><time>{formatHistoryDate(item.createdAt)}</time></span>
            <ChevronRightIcon />
          </button>
        )) : (
          <div className="history-empty"><ClockIcon /><h2>История пока пустая</h2><p>Спросите что-нибудь или отправьте фотографию.</p><button type="button" onClick={onHome}>Начать</button></div>
        )}
      </div>
      <BottomNav active="history" onHome={onHome} onHistory={() => undefined} onProfile={onProfile} />
    </motion.main>
  );
}

function ProfileView({ session, busy, notice, onHome, onHistory, onStars, onBuy, onCheck }: {
  session: SessionPayload;
  busy: string;
  notice: string;
  onHome: () => void;
  onHistory: () => void;
  onStars: () => void;
  onBuy: (packageId: string) => void;
  onCheck: () => void;
}) {
  const [paymentMode, setPaymentMode] = useState<"stars" | "rubles">(session.payments.plategaEnabled ? "rubles" : "stars");
  const planLabel = session.access.plan === "pro" ? "Безлимит" : session.access.plan === "plus" ? "Plus" : "Бесплатный";
  const hasPending = session.payments.recent.some((payment) => payment.status === "pending") || Boolean(window.localStorage.getItem("poymi-pending-payment"));
  return (
    <motion.main className="profile-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <header className="section-topbar"><div><span>Аккаунт</span><h1>Профиль</h1></div><PersonIcon /></header>
      <div className="profile-scroll">
        <section className="profile-hero">
          <div className="profile-avatar">{session.user.firstName.slice(0, 1).toUpperCase()}</div>
          <div><h1>{session.user.firstName}</h1><p>{planLabel} тариф</p></div>
        </section>

        <section className="balance-panel">
          <span>Доступно сейчас</span>
          <strong>{session.access.remaining === null ? "Безлимит" : `${session.access.remaining} запросов`}</strong>
          <small>{planLabel} тариф</small>
        </section>

        <section className="packages-section">
          <div className="section-heading"><h2>Пополнить баланс</h2><span>Запросы не сгорают</span></div>
          <div className="payment-tabs" role="tablist" aria-label="Способ оплаты">
            <button className={paymentMode === "stars" ? "active" : ""} type="button" onClick={() => setPaymentMode("stars")}><StarIcon /> Stars</button>
            {session.payments.plategaEnabled && <button className={paymentMode === "rubles" ? "active" : ""} type="button" onClick={() => setPaymentMode("rubles")}>₽ Карта / СБП</button>}
          </div>
          {paymentMode === "rubles" && session.payments.plategaEnabled ? (
            <div className="package-list">
              {session.payments.packages.map((item) => (
                <button type="button" key={item.id} disabled={Boolean(busy)} onClick={() => onBuy(item.id)}>
                  <span><strong>{item.credits}</strong><small> запросов</small></span>
                  <b>{busy === item.id ? "Открываю…" : `${item.rubles} ₽`}</b>
                  <ChevronRightIcon />
                </button>
              ))}
            </div>
          ) : (
            <div className="stars-offer"><div><strong>Plus на 30 дней</strong><span>100 AI-запросов и до 20 изображений</span></div><button type="button" onClick={onStars}>Выбрать в Telegram</button></div>
          )}
          {notice && <p className="payment-notice">{notice}</p>}
          {hasPending && <button className="check-payment" type="button" disabled={Boolean(busy)} onClick={onCheck}>Проверить оплату</button>}
        </section>

        {session.payments.recent.length > 0 && (
          <section className="purchase-section">
            <h2>Последние покупки</h2>
            {session.payments.recent.slice(0, 3).map((payment) => (
              <div key={payment.transactionId}><span>{payment.credits} запросов</span><small>{paymentStatus(payment.status)}</small><b>{payment.amountRub} ₽</b></div>
            ))}
          </section>
        )}

        <section className="documents-section">
          <div className="section-heading"><h2>Документы и помощь</h2></div>
          <div className="document-list">
            <InfoLink href="/app/tariffs" icon={<ReaderIcon />} title="Тарифы и цены" />
            <InfoLink href="/app/support" icon={<QuestionMarkCircledIcon />} title="Поддержка" />
            <InfoLink href="/app/privacy" icon={<LockClosedIcon />} title="Конфиденциальность" />
            <InfoLink href="/app/terms" icon={<FileTextIcon />} title="Условия использования" />
          </div>
        </section>
      </div>
      <BottomNav active="profile" onHome={onHome} onHistory={onHistory} onProfile={() => undefined} />
    </motion.main>
  );
}

function InfoLink({ href, icon, title }: { href: string; icon: ReactNode; title: string }) {
  return <a href={href}><span>{icon}</span><strong>{title}</strong><ChevronRightIcon /></a>;
}

function InfoPage({ pageId }: { pageId: InfoPageId }) {
  const page = INFO_PAGES[pageId];
  return (
    <main className="info-screen">
      <header className="info-topbar">
        <a href="/app/" aria-label="Вернуться в приложение"><ArrowLeftIcon /></a>
        <Brand compact />
        <span />
      </header>
      <article className="info-content">
        <span className="info-eyebrow">{page.eyebrow}</span>
        <h1>{page.title}</h1>
        <p className="info-intro">{page.intro}</p>
        <p className="info-date">Редакция от 21 августа 2026 года</p>
        {page.sections.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            {section.bullets && <ul>{section.bullets.map((item) => <li key={item}>{item}</li>)}</ul>}
          </section>
        ))}
        {pageId === "support" && (
          <a className="support-link" href="https://t.me/PoymiAI_support" target="_blank" rel="noreferrer">Написать @PoymiAI_support</a>
        )}
        <footer>Пойми AI · @OtvetUmnoAI_bot</footer>
      </article>
    </main>
  );
}

function infoPageFromPath(pathname: string): InfoPageId | undefined {
  const slug = pathname.replace(/\/+$/, "").split("/").pop();
  return slug && slug in INFO_PAGES ? slug as InfoPageId : undefined;
}

function BottomNav({ active, onHome, onHistory, onProfile }: { active: "home" | "history" | "profile"; onHome: () => void; onHistory: () => void; onProfile: () => void }) {
  return <nav className="bottom-nav" aria-label="Разделы">
    <button className={active === "home" ? "active" : ""} type="button" onClick={onHome}><HomeIcon /><span>Главная</span></button>
    <button className={active === "history" ? "active" : ""} type="button" onClick={onHistory}><ClockIcon /><span>История</span></button>
    <button className={active === "profile" ? "active" : ""} type="button" onClick={onProfile}><PersonIcon /><span>Профиль</span></button>
  </nav>;
}

function WorkingView({ previewUrl, text }: { previewUrl: string; text: string }) {
  return (
    <motion.main className="working-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <Brand />
      {previewUrl && <img src={previewUrl} alt="Обрабатываемая фотография" />}
      <ReloadIcon className="spin" />
      <h1>{text}</h1>
      <p>Обычно это занимает несколько секунд</p>
    </motion.main>
  );
}

function ResultView({ access, previewUrl, result, followUps, question, sending, onQuestion, onSubmit, onQuickAction, onBack }: {
  access: AccessPayload;
  previewUrl: string;
  result: string;
  followUps: Array<{ question: string; answer: string }>;
  question: string;
  sending: boolean;
  onQuestion: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onQuickAction: (question: string) => void;
  onBack: () => void;
}) {
  const sections = parseResult(result);
  const headline = sections[0]?.title || "Понятный ответ";
  return (
    <motion.main className="result-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <header className="result-topbar">
        <button type="button" onClick={onBack} aria-label="Назад"><ArrowLeftIcon /></button>
        <Brand compact />
        <span className="result-access">{access.remaining === null ? "∞" : access.remaining}</span>
      </header>
      <div className="result-scroll">
        {previewUrl && <div className="result-photo"><img src={previewUrl} alt="Распознанный предмет" /></div>}
        <section className="summary">
          <span>Ответ Пойми AI</span>
          <h1>{headline}</h1>
          <p><CheckCircledIcon /> Готово</p>
        </section>
        {sections.map((section, index) => (
          <section className="result-section" key={`${section.title}-${index}`}>
            <div>{section.title.toLowerCase().includes("важ") ? <ExclamationTriangleIcon /> : <FileTextIcon />}</div>
            <article><h2>{section.title}</h2><p>{section.body}</p></article>
          </section>
        ))}
        <div className="result-actions" aria-label="Продолжить ответ">
          <button type="button" disabled={sending} onClick={() => onQuickAction("Объясни это ещё проще и короче")}>Объяснить проще</button>
          <button type="button" disabled={sending} onClick={() => onQuickAction("Что мне делать дальше? Дай конкретные шаги")}>Что делать дальше</button>
        </div>
        {followUps.map((item, index) => (
          <section className="follow-up-answer" key={`${item.question}-${index}`}><small>Ваш вопрос</small><h2>{item.question}</h2><p>{item.answer}</p></section>
        ))}
        <div className="scroll-space" />
      </div>
      <form className="result-composer" onSubmit={onSubmit}>
        <Link2Icon />
        <input value={question} onChange={(event) => onQuestion(event.target.value)} placeholder="Задать вопрос" aria-label="Уточняющий вопрос" />
        <button type="submit" disabled={!question.trim() || sending} aria-label="Отправить вопрос">{sending ? <ReloadIcon className="spin" /> : <PaperPlaneIcon />}</button>
      </form>
    </motion.main>
  );
}

function MessageView({ title, text, action, onAction, onBack }: { title: string; text: string; action: string; onAction: () => void; onBack: () => void }) {
  return (
    <motion.main className="message-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <Brand />
      <div><ExclamationTriangleIcon /><h1>{title}</h1><p>{text}</p><button type="button" onClick={onAction}>{action}</button><button className="secondary" type="button" onClick={onBack}>На главный экран</button></div>
    </motion.main>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? "compact" : ""}`}><img src="/app/poymi-avatar-2026.jpg" alt="" /><span>Пойми AI</span></div>;
}

function parseResult(result: string): ResultSection[] {
  const sections: ResultSection[] = [];
  let current: ResultSection | undefined;
  for (const rawLine of result.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const looksLikeHeading = line.length <= 48 && !/[.!?]$/.test(line);
    if (looksLikeHeading && (!current || current.body)) {
      if (current?.body) sections.push(current);
      current = { title: line.replace(/^\S+\s*/, (value) => /[А-ЯA-Z]/.test(value) ? value : ""), body: "" };
    } else if (current) {
      current.body += `${current.body ? "\n" : ""}${line}`;
    } else {
      current = { title: "Понятный ответ", body: line };
    }
  }
  if (current?.body) sections.push(current);
  return sections.length ? sections : [{ title: "Понятный ответ", body: result }];
}

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Недавно";
  const isToday = date.toDateString() === new Date().toDateString();
  return `${isToday ? "Сегодня" : "Вчера"}, ${date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
}

function historyTitle(item: HistoryItem): string {
  const source = item.source.trim();
  if (source.toLowerCase().includes("фото")) return "Разбор фотографии";
  if (source.length <= 34) return source;
  return `${source.slice(0, 34).trim()}…`;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function paymentStatus(status: "pending" | "confirmed" | "canceled" | "chargebacked"): string {
  if (status === "confirmed") return "Оплачено";
  if (status === "pending") return "Ожидает оплаты";
  if (status === "chargebacked") return "Возврат";
  return "Отменено";
}
