export const API_IDS = {
  // Course APIs
  CREATE_COURSE: 'api.course.create',
  SEARCH_COURSES: 'api.course.search',
  GET_COURSE_BY_ID: 'api.course.read',
  GET_COURSE_HIERARCHY: 'api.course.hierarchy',
  GET_COURSE_HIERARCHY_WITH_TRACKING: 'api.course.tracking',
  UPDATE_COURSE: 'api.course.update',
  DELETE_COURSE: 'api.course.delete',
  COPY_COURSE: 'api.course.clone',
  UPDATE_COURSE_STRUCTURE: 'api.course.restructure',
  UPDATE_COURSES_ORDER: 'api.courses.order',
  GET_NEXT_COURSE_MODULE_LESSON: 'api.course.next',


  // Module APIs
  CREATE_MODULE: 'api.module.create',
  GET_MODULE_BY_ID: 'api.module.read',
  GET_MODULES_BY_COURSE: 'api.module.list',
  GET_SUBMODULES_BY_PARENT: 'api.module.list',
  SEARCH_MODULES: 'api.module.search',
  UPDATE_MODULE: 'api.module.update',
  DELETE_MODULE: 'api.module.delete',
  CLONE_MODULE: 'api.module.clone',
  
  // Lesson APIs
  CREATE_LESSON: 'api.lesson.create',
  GET_ALL_LESSONS: 'api.lesson.list',
  GET_LESSON_BY_ID: 'api.lesson.read',
  GET_LESSONS_BY_MODULE: 'api.lesson.list',
  GET_LESSON_BY_TEST_ID: 'api.lesson.read',
  UPDATE_LESSON: 'api.lesson.update',
  DELETE_LESSON: 'api.lesson.delete',
  CLONE_LESSON: 'api.lesson.clone',
  
    // Media APIs
  UPLOAD_MEDIA: 'api.media.upload',
  GET_MEDIA_LIST: 'api.media.list',
  GET_MEDIA_BY_ID: 'api.media.read',
  ASSOCIATE_MEDIA_WITH_LESSON: 'api.media.associate.create',
  DELETE_MEDIA: 'api.media.delete',
  REMOVE_MEDIA_ASSOCIATION: 'api.media.associate.delete',
  
   // Enrollment APIs
  ENROLL_USER: 'api.enrollment.create',
  GET_USER_ENROLLMENTS: 'api.enrollment.list',
  GET_ENROLLMENT_BY_ID: 'api.enrollment.read',
  UPDATE_ENROLLMENT: 'api.enrollment.update',
  CANCEL_ENROLLMENT: 'api.enrollment.cancel',
  DELETE_ENROLLMENT: 'api.enrollment.delete',
  GET_ENROLLED_COURSES: 'api.enrollment.courses',

  
  // Tracking APIs
  GET_COURSE_TRACKING: 'api.course.progress.read',
  UPDATE_COURSE_TRACKING: 'api.course.progress.update',
  START_LESSON_ATTEMPT: 'api.lesson.attempt.start',
  MANAGE_LESSON_ATTEMPT: 'api.lesson.attempt.startover',
  GET_LESSON_STATUS: 'api.lesson.attempt.status',
  GET_LESSON_PREREQUISITES: 'api.lesson.prerequisites.read',
  GET_ATTEMPT: 'api.lesson.attempt.read',
  UPDATE_ATTEMPT_PROGRESS: 'api.lesson.attempt.update',
  UPDATE_EVENT_LESSON: 'api.lesson.event.update',
  RECALCULATE_PROGRESS: 'api.tracking.recalculate.progress',

  // Aspire Leader Report APIs
  GET_COURSE_REPORT: 'api.course.report',
  GET_LESSON_COMPLETION_STATUS: 'api.lesson.completion.status',
  UPDATE_TEST_PROGRESS: 'api.tracking.update_test_progress',
};