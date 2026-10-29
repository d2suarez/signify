/**
 * Every word on screen comes from here, in English and Spanish, from the
 * first screen on: adding a language later means filling a dictionary, not
 * hunting through components. Missing Spanish falls back to English.
 */

const en = {
  appName: "Signify Learning",
  myCourses: "My courses",
  teaching: "Teaching",
  learning: "Learning",
  noCourses: "No courses yet. Classes you teach in Signify ID appear here.",
  classesFailed: "Your classes couldn't be loaded from Signify ID. Try again in a minute.",
  tryAgain: "Try again",
  lessons: "lessons",
  lesson: "lesson",
  covering: "Covering",
  newLesson: "New lesson",
  lessonTitle: "Lesson title",
  create: "Create",
  noLessons: "No lessons yet. Create the first one.",
  noLessonsStudent: "Nothing here yet. Your teacher's lessons appear when they present them.",
  edit: "Edit",
  present: "Present",
  blocks: "blocks",
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Unsaved changes",
  saveFailed: "Couldn't save. Your changes are kept on this page; it will try again.",
  conflict: "This lesson was changed somewhere else, so this page stopped saving. Reload to see the latest version; your text below is still here to copy.",
  reload: "Reload",
  version: "version",
  addBlock: "Add a block",
  blockText: "Content",
  blockPoll: "Poll",
  blockTimer: "Timer",
  title: "Title",
  body: "Text",
  question: "Question",
  choice: "Choice",
  correct: "Correct",
  addChoice: "Add choice",
  showResults: "Show results to students",
  whenIChoose: "When I choose",
  never: "Never",
  label: "Label",
  minutes: "Minutes",
  moveUp: "Move up",
  moveDown: "Move down",
  remove: "Remove",
  earlierVersions: "Earlier versions",
  noVersions: "Earlier versions appear here after the first change.",
  restore: "Restore",
  plannedFor: "Planned for",
  duration: "Minutes",
  backToCourse: "Back to course",
  emptyLesson: "This lesson has no blocks yet. Add one below.",
  signOut: "Sign out",
  back: "Back",
  next: "Next",
  endLesson: "End",
  following: "following",
  of: "of",
  showToClass: "Show results to class",
  hideResults: "Hide results",
  answered: "answered",
  waitingForTeacher: "Waiting for your teacher to start the lesson.",
  followingTeacher: "Following your teacher",
  chooseOne: "Choose one",
  answerSent: "Answer sent. You can change it until your teacher moves on.",
  connectionLost: "Reconnecting…",
  joinLive: "Join the live lesson",
  liveNow: "Live now",
  notYourCourse: "You're not in this course.",
  studentsNow: "students connected",
};

export type Key = keyof typeof en;

const es: Partial<Record<Key, string>> = {
  myCourses: "Mis cursos",
  teaching: "Enseñando",
  learning: "Aprendiendo",
  noCourses: "Todavía no hay cursos. Las clases que enseñas en Signify ID aparecen aquí.",
  lessons: "lecciones",
  lesson: "lección",
  newLesson: "Nueva lección",
  create: "Crear",
  edit: "Editar",
  present: "Presentar",
  saved: "Guardado",
  saving: "Guardando…",
  addBlock: "Agregar un bloque",
  question: "Pregunta",
  back: "Atrás",
  next: "Siguiente",
  waitingForTeacher: "Esperando a que tu maestro comience la lección.",
  followingTeacher: "Siguiendo a tu maestro",
  chooseOne: "Elige una",
  answerSent: "Respuesta enviada. Puedes cambiarla hasta que tu maestro avance.",
  connectionLost: "Reconectando…",
  joinLive: "Unirse a la lección en vivo",
  liveNow: "En vivo",
};

const dicts = { en, es } as const;
export type Lang = keyof typeof dicts;

export function t(key: Key, lang: Lang = "en"): string {
  return (dicts[lang] as Partial<Record<Key, string>>)[key] ?? en[key];
}

export function pickLang(acceptLanguage: string | null | undefined, cookie?: string | null): Lang {
  if (cookie === "es" || cookie === "en") return cookie;
  return /^es\b/i.test(acceptLanguage || "") ? "es" : "en";
}

export type Dict = Record<Key, string>;

/** The whole dictionary for one language, to hand to client components. */
export function dict(lang: Lang): Dict {
  const out = {} as Dict;
  for (const k of Object.keys(en) as Key[]) out[k] = t(k, lang);
  return out;
}
