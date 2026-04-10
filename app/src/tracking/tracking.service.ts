import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, Not, FindManyOptions, IsNull, In } from 'typeorm';
import { CourseTrack, TrackingStatus } from './entities/course-track.entity';
import { LessonTrack } from './entities/lesson-track.entity';
import { Course, CourseStatus } from '../courses/entities/course.entity';
import { Lesson, LessonStatus, AttemptsGradeMethod, LessonFormat } from '../lessons/entities/lesson.entity';
import { Module, ModuleStatus } from '../modules/entities/module.entity';
import { RESPONSE_MESSAGES } from '../common/constants/response-messages.constant';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import {
  UserJourneyDto,
  UserJourneyResponseDto,
  UserJourneyItemDto,
} from './dto/user-journey.dto';
import { UpdateLessonTrackingDto } from './dto/update-lesson-tracking.dto';
import { UpdateCourseTrackingDto } from './dto/update-course-tracking.dto';
import { UpdateEventProgressDto } from './dto/update-event-progress.dto';
import { LessonStatusDto } from './dto/lesson-status.dto';
import { ConfigService } from '@nestjs/config';
import { ModuleTrack, ModuleTrackStatus } from './entities/module-track.entity';
import { LessonsService } from '../lessons/lessons.service';
import { CacheService } from '../cache/cache.service';
import axios from 'axios';

type FinalAssessmentOutcome = 'pass' | 'fail' | 'submitted' | null;

/**
 * Controls how `progressDetail.assessmentOutcome` is computed for user journey (one “final” assessment
 * lesson per course).
 *
 * - **formal_assessment** — Linked `tests.gradingType` is `assessment`. Use assessment-service
 *   `isImported` plus pass / fail / submitted rules (reviewed attempt, passing marks, etc.).
 * - **non_formal_grading** — Linked test is quiz, feedback, reflection.prompt, etc. This field is not
 *   used like a formal end-of-module assessment: completed attempts → `null`; submitted → `submitted` only.
 * - **fallback** — No test UUID on lesson media, metadata HTTP call failed, or `gradingType` missing on
 *   the response. Uses the older combined path: LMS `lesson_track` plus `isImported` when present.
 */
const USER_OUTCOME_MODE = {
  FORMAL_ASSESSMENT: 'formal_assessment',
  NON_FORMAL_GRADING: 'non_formal_grading',
  FALLBACK: 'fallback',
} as const;

type UserOutcomeMode =
  (typeof USER_OUTCOME_MODE)[keyof typeof USER_OUTCOME_MODE];

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    @InjectRepository(CourseTrack)
    private readonly courseTrackRepository: Repository<CourseTrack>,
    @InjectRepository(LessonTrack)
    private readonly lessonTrackRepository: Repository<LessonTrack>,
    @InjectRepository(Course)
    private readonly courseRepository: Repository<Course>,
    @InjectRepository(Lesson)
    private readonly lessonRepository: Repository<Lesson>,
    @InjectRepository(Module)
    private readonly moduleRepository: Repository<Module>,
    @InjectRepository(ModuleTrack)
    private readonly moduleTrackRepository: Repository<ModuleTrack>,
    private readonly configService: ConfigService,
    private readonly lessonsService: LessonsService,
    private readonly enrollmentsService: EnrollmentsService,
    private readonly cacheService: CacheService,
  ) {}

  /**
   * Get course tracking
   * @param courseId The course ID
   * @param userId The user ID
   * @param tenantId The tenant ID for data isolation
   * @param orgId The organization ID for data isolation
   */
  async getCourseTracking(
    courseId: string, 
    userId: string,
    tenantId?: string,
    organisationId?: string
  ): Promise<CourseTrack> {
    // Build where clause with required filters
    const whereClause: any = { 
      courseId, 
      userId,
      tenantId,
      organisationId
    };
          
    const courseTrack = await this.courseTrackRepository.findOne({
      where: whereClause,
    });

    if (!courseTrack) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.COURSE_TRACKING_NOT_FOUND);
    }

    return courseTrack;
  }

  /**
   * Update course tracking
   * @param courseId The course ID
   * @param userId The user ID
   * @param updateCourseTrackingDto The update data
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   */
  async updateCourseTracking(
    courseId: string, 
    userId: string,
    updateCourseTrackingDto: UpdateCourseTrackingDto,
    tenantId?: string,
    organisationId?: string
  ): Promise<CourseTrack> {
    // Build where clause with required filters
    const whereClause: any = { 
      courseId, 
      userId,
      tenantId,
      organisationId
    };
          
    const courseTrack = await this.courseTrackRepository.findOne({
      where: whereClause,
    });

    if (!courseTrack) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.COURSE_TRACKING_NOT_FOUND);
    }

    // Update fields if provided in the DTO
    if (updateCourseTrackingDto.status !== undefined) {
      courseTrack.status = updateCourseTrackingDto.status;
    }

    if (updateCourseTrackingDto.startDatetime !== undefined) {
      courseTrack.startDatetime = new Date(updateCourseTrackingDto.startDatetime);
    }

    if (updateCourseTrackingDto.endDatetime !== undefined) {
      courseTrack.endDatetime = new Date(updateCourseTrackingDto.endDatetime);
    }

    if (updateCourseTrackingDto.noOfLessons !== undefined) {
      courseTrack.noOfLessons = updateCourseTrackingDto.noOfLessons;
    }

    if (updateCourseTrackingDto.completedLessons !== undefined) {
      courseTrack.completedLessons = updateCourseTrackingDto.completedLessons;
    }

    if (updateCourseTrackingDto.lastAccessedDate !== undefined) {
      courseTrack.lastAccessedDate = new Date(updateCourseTrackingDto.lastAccessedDate);
    }

    if (updateCourseTrackingDto.certGenDate !== undefined) {
      courseTrack.certGenDate = new Date(updateCourseTrackingDto.certGenDate);
    }
    
    // Auto-update status based on completion
    if (courseTrack.completedLessons === courseTrack.noOfLessons && courseTrack.noOfLessons > 0) {
      courseTrack.status = TrackingStatus.COMPLETED;
      if (!courseTrack.endDatetime) {
        courseTrack.endDatetime = new Date();
      }
    }
    
    // Update last accessed date if not explicitly provided
    if (!updateCourseTrackingDto.lastAccessedDate) {
      courseTrack.lastAccessedDate = new Date();
    }

    if (updateCourseTrackingDto.certificateIssued !== undefined) {
      courseTrack.certificateIssued = updateCourseTrackingDto.certificateIssued;
    }

    // Save the updated course track
    const updatedCourseTrack = await this.courseTrackRepository.save(courseTrack);

    return updatedCourseTrack;
  }

  /**
   * Start a new lesson attempt or get existing incomplete attempt
   * OPTIMIZED: Parallel queries and batch loading for prerequisites
   */
  async startLessonAttempt(
    lessonId: string,
    userId: string,
    tenantId: string,
    organisationId: string
  ): Promise<LessonTrack> {
    // OPTIMIZED: Get lesson details first
    const lesson = await this.lessonRepository.findOne({
      where: { 
        lessonId,
        tenantId,
        organisationId
      } as FindOptionsWhere<Lesson>,
    });

    if (!lesson) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.LESSON_NOT_FOUND);
    }

    const courseId = lesson.courseId;
    
    if (!courseId) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.COURSE_LESSON_NOT_FOUND);
    }

    // OPTIMIZED: Check prerequisites and get existing tracks in parallel
    // This reduces sequential queries from 2 to 1 (parallel execution)
    const [prerequisiteCheck, existingTracks] = await Promise.all([
      this.checkLessonsPrerequisites(
        lesson,
        userId,
        courseId,
        tenantId,
        organisationId
      ),
      this.lessonTrackRepository.find({
        where: { 
          lessonId, 
          userId,
          courseId,
          tenantId,
          organisationId,
        } as FindOptionsWhere<LessonTrack>,
        order: { attempt: 'DESC' },
      })
    ]);

    if (!prerequisiteCheck.isEligible && prerequisiteCheck.requiredLessons) {
      // Get the titles of missing prerequisite lessons for better error message
      const missingPrerequisiteLessons = prerequisiteCheck.requiredLessons.filter(l => !l.completed);
      const missingLessonTitles = missingPrerequisiteLessons.map(l => l.title).join(', ');
      throw new BadRequestException(
        `Cannot start lesson. Prerequisites not completed: ${missingLessonTitles}. Please complete the required lessons first.`
      );
    }

    // REMOVED: Unused courseTrack query (check was commented out)
    // This eliminates an unnecessary database query

    // If there's an incomplete attempt, return it
    const incompleteAttempt = existingTracks.find(track => track.status !== TrackingStatus.COMPLETED);
    if (incompleteAttempt) {
      //check can resume
      const canResume = lesson.resume ?? true;
      if (canResume) {
        return incompleteAttempt;
      }      
    }
    if (lesson.allowResubmission && existingTracks.length > 0) {
      // If resubmission is allowed, always return the existing attempt
      return existingTracks[0];
    }

    // Check max attempts
    const maxAttempts = lesson.noOfAttempts ?? 1;
    if (maxAttempts > 0 && existingTracks.length > 0 && existingTracks[0].attempt >= maxAttempts) {
      throw new BadRequestException(RESPONSE_MESSAGES.ERROR.MAX_ATTEMPTS_REACHED);
    }

    // Create new attempt
    const lessonTrack = this.lessonTrackRepository.create({
      userId,
      lessonId,
      courseId,
      tenantId,
      organisationId,
      attempt: existingTracks.length > 0 ? existingTracks[0].attempt + 1 : 1,
      status: TrackingStatus.STARTED,
      startDatetime: new Date(),
      totalContent: 0,
      completionPercentage: 0,
      score: 0,
      currentPosition: 0,
      timeSpent: 0
    });
    
    // Save lesson track first
    const savedLessonTrack = await this.lessonTrackRepository.save(lessonTrack);

    // Update course and module tracking asynchronously (fire and forget) to avoid blocking response
    // This matches the pattern used in updateProgress for consistency
    if (savedLessonTrack.courseId) {
      this.updateCourseAndModuleTracking(savedLessonTrack, tenantId, organisationId)
        .catch(err => this.logger.error('Failed to update course/module tracking asynchronously', err));
    }

    return savedLessonTrack;
  }


  /**
   * Check if all prerequisites for a lesson are completed
   * OPTIMIZED: Batch load all prerequisites and completion checks to avoid N+1 queries
   * @param lesson The lesson to check prerequisites for
   * @param userId The user ID
   * @param courseId The course ID
   * @param tenantId The tenant ID
   * @param organisationId The organization ID
   * @returns Promise with prerequisite status information
   */
  private async checkLessonsPrerequisites(
    lesson: Lesson,
    userId: string,
    courseId: string,
    tenantId: string,
    organisationId: string
  ): Promise<{isEligible: boolean, requiredLessons: any[]}> {
    if (!lesson.prerequisites || lesson.prerequisites.length === 0) {
      return {
        isEligible: true,
        requiredLessons: []
      };
    }

    // OPTIMIZED: Batch load all prerequisite lessons in a single query
    // Instead of N queries (one per prerequisite), we fetch all at once
    const prerequisiteLessonIds = lesson.prerequisites;
    const requiredLessonsData = await this.lessonRepository.find({
      where: {
        lessonId: In(prerequisiteLessonIds),
        tenantId,
        organisationId,
        status: LessonStatus.PUBLISHED
      },
      select: ['lessonId', 'title']
    });

    // OPTIMIZED: Batch load all completion tracks in a single query
    // Instead of N queries (one per prerequisite), we fetch all at once
    const completedTracks = await this.lessonTrackRepository.find({
      where: {
        lessonId: In(prerequisiteLessonIds),
        userId,
        courseId,
        tenantId,
        organisationId,
        status: TrackingStatus.COMPLETED
      } as FindOptionsWhere<LessonTrack>,
      select: ['lessonId']
    });

    // Create a map for quick lookup of completed lessons
    const completedLessonIds = new Set(completedTracks.map(track => track.lessonId));
    
    // Create a map for quick lookup of lesson titles
    const lessonTitleMap = new Map(requiredLessonsData.map(lesson => [lesson.lessonId, lesson.title]));

    const requiredLessons: any[] = [];
    let allCompleted = true;

    // Process each prerequisite (now using pre-loaded data)
    for (const requiredLessonId of prerequisiteLessonIds) {
      const title = lessonTitleMap.get(requiredLessonId) || 'Unknown Lesson';
      const isCompleted = completedLessonIds.has(requiredLessonId);

      requiredLessons.push({
        lessonId: requiredLessonId,
        title: title,
        completed: isCompleted
      });

      if (!isCompleted) {
        allCompleted = false;
      }
    }

    return {
      isEligible: allCompleted,
      requiredLessons
    };
  }


  /**
   * Manage lesson attempt - start over or resume
   */
  async manageLessonAttempt(
    lessonId: string,
    action: 'start' | 'resume',
    userId: string,
    tenantId: string,
    organisationId: string
  ): Promise<LessonTrack> {
    // Get lesson details first
    const lesson = await this.lessonRepository.findOne({
      where: { 
        lessonId,
        tenantId,
        organisationId
      } as FindOptionsWhere<Lesson>,
    });

    if (!lesson) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.LESSON_NOT_FOUND);
    }

    const courseId = lesson.courseId;
    
    if (!courseId) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.COURSE_LESSON_NOT_FOUND);
    }
    
    // Find existing tracks for course lesson
    const existingTracks = await this.lessonTrackRepository.find({
      where: { 
        lessonId, 
        userId,
        courseId,
        tenantId,
        organisationId
      } as FindOptionsWhere<LessonTrack>,
      order: { attempt: 'DESC' },
      take: 1,
    });

    if (existingTracks.length === 0) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.NO_EXISTING_ATTEMPT);
    }
    

    const latestTrack = existingTracks[0];
   
    if (action === 'resume') {
      // For resubmission mode, always allow resume regardless of lesson.resume setting
      if (lesson.allowResubmission) {
        return latestTrack;
      }
      
      // Check if lesson allows resume
      const canResume = lesson.resume ?? true;
      if (!canResume) {
        throw new BadRequestException(RESPONSE_MESSAGES.ERROR.RESUME_NOT_ALLOWED);
      }
      if (latestTrack.status === TrackingStatus.COMPLETED) {
        throw new BadRequestException(RESPONSE_MESSAGES.ERROR.CANNOT_RESUME_COMPLETED);
      }
      return latestTrack;
    } else { 
      // start over
      if (lesson.allowResubmission) {
        // For resubmission mode, reset the existing attempt instead of creating new one
        latestTrack.status = TrackingStatus.STARTED;
        latestTrack.startDatetime = new Date();
        latestTrack.completionPercentage = 0;
        latestTrack.score = 0;
        latestTrack.totalContent = 0;
        latestTrack.currentPosition = 0;
        latestTrack.timeSpent = 0;
        
        const savedTracking = await this.lessonTrackRepository.save(latestTrack);
        return savedTracking;
      }
      
      if (latestTrack.status === TrackingStatus.COMPLETED) {
        throw new BadRequestException(RESPONSE_MESSAGES.ERROR.CANNOT_START_COMPLETED);
      }
      
      // Check max attempts
      const maxAttempts = lesson.noOfAttempts || 1;
      if (maxAttempts > 0 && latestTrack.attempt >= maxAttempts) {
        throw new BadRequestException(RESPONSE_MESSAGES.ERROR.MAX_ATTEMPTS_REACHED);
      }

      // Create new attempt
      const lessonTrack = this.lessonTrackRepository.create({
        userId,
        lessonId,
        courseId,
        tenantId,
        organisationId,
        attempt: latestTrack.attempt,
        status: TrackingStatus.STARTED,
        startDatetime: new Date(),
        completionPercentage: 0,
        score: 0,
        totalContent: 0,
        currentPosition: 0,
        timeSpent: 0
      });
      
      const savedTracking = await this.lessonTrackRepository.save(lessonTrack);
      
      return savedTracking;
    }
  }

  /**
   * Get lesson status for a user
   */
  async getLessonStatus(
    lessonId: string,
    userId: string,
    tenantId: string,
    organisationId: string
  ): Promise<LessonStatusDto> {
    // Get lesson
    const lesson = await this.lessonRepository.findOne({
      where: { 
        lessonId,
        tenantId,
        organisationId,
        status: Not(LessonStatus.ARCHIVED)
      } as FindOptionsWhere<Lesson>,
    });

    if (!lesson) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.LESSON_NOT_FOUND);
    }

    if (!lesson.courseId) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.COURSE_LESSON_NOT_FOUND);
    } 

    // Find latest attempt
    const latestTrack = await this.lessonTrackRepository.findOne({
      where: { 
        lessonId, 
        userId,
        courseId: lesson.courseId,
        tenantId,
        organisationId
      } as FindOptionsWhere<LessonTrack>,
      order: { attempt: 'DESC' },
    });

    //check lesson prerequisites
    const prerequisiteCheck = await this.checkLessonsPrerequisites(
      lesson,
      userId,
      lesson.courseId,
      tenantId,
      organisationId
    );

    const status: LessonStatusDto = {
      canResume: false,
      canReattempt: false,
      lastAttemptStatus: TrackingStatus.NOT_STARTED,
      lastAttemptId: null,
      isEligible: prerequisiteCheck.isEligible,
      requiredLessons: prerequisiteCheck.requiredLessons
    };

    if (!prerequisiteCheck.isEligible) {
      status.canResume = false;
      status.canReattempt = false;
      status.lastAttemptStatus = TrackingStatus.NOT_ELIGIBLE;
      status.lastAttemptId = null;
      status.isEligible = false;
      status.requiredLessons = prerequisiteCheck.requiredLessons;
      return status;
    }

    if (latestTrack) {
      status.lastAttemptId = latestTrack.lessonTrackId;
      status.lastAttemptStatus = latestTrack.status;

      if (lesson.allowResubmission) {
        // For resubmission mode, always allow resume and reattempt
        status.canResume = true;
        status.canReattempt = true;
      } else {
        // Original logic for non-resubmission mode
        const canResume = lesson.resume ?? true;
        if (canResume && (latestTrack.status === TrackingStatus.STARTED || latestTrack.status === TrackingStatus.INCOMPLETE)) {
          status.canResume = true;
        }

        const maxAttempts = lesson.noOfAttempts || 0;
        if ((maxAttempts === 0 || latestTrack.attempt < maxAttempts) && latestTrack.status === TrackingStatus.COMPLETED) {
          status.canReattempt = true;
        }
      }
    } else {
      // No attempts yet, can start first attempt
      status.canReattempt = true;
    }

    return status;
  }

  /**
   * Get an attempt
   * 
   * IMPORTANT: This API contains userId in the response, so we DO NOT cache the response.
   * However, lesson data is read-only and safe to cache. We fetch the lesson separately
   * through LessonsService.findOne() which handles caching, while tracking/attempt data is
   * always fetched live from the database.
   */
  async getAttempt(
    attemptId: string,
    userId: string,
    tenantId: string,
    organisationId: string
  ): Promise<LessonTrack> {
    // Fetch attempt without lesson relation - tracking data must always be fresh
    // Lesson data may come from cache via LessonsService.findOne()
    const attempt = await this.lessonTrackRepository.findOne({
      where: { 
        lessonTrackId: attemptId,
        userId,
        tenantId,
        organisationId
      } as FindOptionsWhere<LessonTrack>,
    });

    if (!attempt) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.ATTEMPT_NOT_FOUND);
    }

    // Fetch lesson separately through LessonsService.findOne() which handles caching
    // Lesson is read-only data, safe to cache. Tracking/attempt data is NOT cached.
    const lesson = await this.lessonsService.findOne(
      attempt.lessonId,
      tenantId,
      organisationId
    );

    // Attach lesson to attempt to maintain identical response structure
    attempt.lesson = lesson;

    return attempt;
  }

  /**
   * Update attempt progress
   */
  async updateProgress(
    attemptId: string,
    updateProgressDto: UpdateLessonTrackingDto,
    userId: string,
    tenantId: string,
    organisationId: string
  ): Promise<LessonTrack> {
    const attempt = await this.lessonTrackRepository.findOne({
      where: { 
        lessonTrackId: attemptId,
        userId,
        tenantId,
        organisationId
      } as FindOptionsWhere<LessonTrack>,
      relations: ['lesson'], // Load lesson to avoid redundant query later
    });

    if (!attempt) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.ATTEMPT_NOT_FOUND);
    }

    // Update progress
    attempt.currentPosition = updateProgressDto.currentPosition || 0;
    attempt.score = updateProgressDto.score || 0;
    attempt.timeSpent = (attempt.timeSpent || 0) + (updateProgressDto.timeSpent || 0);
    attempt.totalContent = updateProgressDto.totalContent || 0;

    // Update completion percentage if provided
    if (updateProgressDto.completionPercentage !== undefined) {
      attempt.completionPercentage = updateProgressDto.completionPercentage;
    } else if (updateProgressDto.currentPosition && updateProgressDto.totalContent) {
      // Calculate completion percentage if not provided but position and total content are available
      attempt.completionPercentage = Math.round((updateProgressDto.currentPosition / updateProgressDto.totalContent) * 100);
    }

    // Update params if provided
    if (updateProgressDto.params) {
      attempt.params = updateProgressDto.params;
    }

    // Update status if completed
    if (updateProgressDto.currentPosition === updateProgressDto.totalContent || 
        (updateProgressDto.completionPercentage !== undefined && updateProgressDto.completionPercentage >= 100) ||
      (updateProgressDto.status === TrackingStatus.COMPLETED)) {
      attempt.status = TrackingStatus.COMPLETED;
      attempt.endDatetime = new Date();
      attempt.completionPercentage = 100; // Ensure completion percentage is 100 when completed
    } else if (attempt.status === TrackingStatus.STARTED) {
      attempt.status = TrackingStatus.INCOMPLETE;
    }

    if(updateProgressDto.status !== undefined) {
      attempt.status = updateProgressDto.status;
    }
    
    attempt.updatedAt = new Date();
    attempt.updatedBy = userId;

    const savedAttempt = await this.lessonTrackRepository.save(attempt);

    // Update course and module tracking asynchronously (fire and forget) to avoid blocking response
    // Skip expensive operations for incomplete status - no need to recalculate course completion
    if (savedAttempt.courseId && savedAttempt.status !== TrackingStatus.INCOMPLETE) {
      this.updateCourseAndModuleTracking(savedAttempt, tenantId, organisationId)
        .catch(err => this.logger.error('Failed to update course/module tracking asynchronously', err));
    }

    // Remove lesson relation from response to reduce payload size (lesson was loaded only for internal use)
    const { lesson, course, ...response } = savedAttempt;
    return response as unknown as LessonTrack;
  }

  /**
   * Helper method to update course and module tracking
   */
  public async updateCourseAndModuleTracking(lessonTrack: LessonTrack, tenantId: string, organisationId: string): Promise<void> {
    if (!lessonTrack.courseId) {
      return;
    }

    // Get course track
    let courseTrack = await this.courseTrackRepository.findOne({
      where: { 
        courseId: lessonTrack.courseId, 
        userId: lessonTrack.userId,
        tenantId,
        organisationId
      } as FindOptionsWhere<CourseTrack>,
    });

    if (!courseTrack) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.COURSE_TRACKING_NOT_FOUND);   
    }

    // Update course track
    courseTrack.lastAccessedDate = new Date();

    // If the lesson is completed, update completed lessons count
    if (lessonTrack.status === TrackingStatus.COMPLETED || courseTrack.status === TrackingStatus.STARTED || lessonTrack.status === TrackingStatus.SUBMITTED) {
      // Get all parent lessons for this course that have considerForPassing = true
      const courseLessons = await this.lessonRepository.find({
        where: { 
          courseId: lessonTrack.courseId,
          tenantId,
          organisationId,
          status: LessonStatus.PUBLISHED,
          considerForPassing: true,
          parentId: IsNull() // Only consider parent lessons for completion tracking
        } as FindOptionsWhere<Lesson>,
      });

      // Calculate completed lessons based on attemptsGrade
      const completedLessonsCount = await this.calculateCompletedLessonsBasedOnAttemptsGrade(
        courseLessons,
        lessonTrack.userId,
        lessonTrack.courseId,
        tenantId,
        organisationId
      );

      
      // Update course track
      courseTrack.completedLessons = completedLessonsCount;
      
      // Check if course is completed
      if (courseTrack.completedLessons >= courseTrack.noOfLessons && lessonTrack.status === TrackingStatus.COMPLETED) {
        courseTrack.status = TrackingStatus.COMPLETED;
        courseTrack.endDatetime = new Date();
        
      } else {
        courseTrack.status = TrackingStatus.INCOMPLETE;
      }
    }
    await this.courseTrackRepository.save(courseTrack);

    // Find and update module tracking if applicable
    // Use lesson from relation if available (loaded in updateProgress), otherwise query
    let lesson = (lessonTrack as any).lesson;
    if (!lesson) {
      lesson = await this.lessonRepository.findOne({
        where: { 
          lessonId: lessonTrack.lessonId,
        } as FindOptionsWhere<Lesson>,
      });
    }

    if (lesson && lesson.moduleId) {
      await this.updateModuleTracking(lesson.moduleId, lessonTrack.userId, lessonTrack.tenantId, lessonTrack.organisationId);
    }
  }

  /**
   * Calculate completed lessons based on attemptsGrade method
   */
  /**
   * Calculate completed lessons based on attemptsGrade method
   * OPTIMIZED: Uses batch query to avoid N+1 problem
   */
  private async calculateCompletedLessonsBasedOnAttemptsGrade(
    lessons: Lesson[],
    userId: string,
    courseId: string | null,
    tenantId: string,
    organisationId: string
  ): Promise<number> {
    if (lessons.length === 0) {
      return 0;
    }

    // Step 1: Get all lesson IDs
    const lessonIds = lessons.map(l => l.lessonId);

    // Step 2: Single batch query for ALL attempts (fixes N+1 problem)
    const whereClause: any = {
      lessonId: In(lessonIds),
      userId,
      tenantId,
      organisationId,
      status: In([TrackingStatus.COMPLETED, TrackingStatus.SUBMITTED])
    };
    
    // Add courseId filter only if it's provided
    if (courseId) {
      whereClause.courseId = courseId;
    }

    const allAttempts = await this.lessonTrackRepository.find({
      where: whereClause as FindOptionsWhere<LessonTrack>,
      order: { attempt: 'ASC' }
    });

    // Step 3: Group attempts by lessonId in memory
    const attemptsByLesson = new Map<string, LessonTrack[]>();
    allAttempts.forEach(attempt => {
      if (!attemptsByLesson.has(attempt.lessonId)) {
        attemptsByLesson.set(attempt.lessonId, []);
      }
      attemptsByLesson.get(attempt.lessonId)!.push(attempt);
    });

    // Step 4: Process each lesson using the grouped data
    let completedLessonsCount = 0;
    for (const lesson of lessons) {
      const lessonAttempts = attemptsByLesson.get(lesson.lessonId) || [];

      if (lessonAttempts.length === 0) {
        continue; // No completed attempts
      }

      let isLessonCompleted = false;

      switch (lesson.attemptsGrade) {
        case AttemptsGradeMethod.FIRST_ATTEMPT:
          // Consider completed if first attempt is completed
          isLessonCompleted = lessonAttempts.some(attempt => attempt.attempt === 1);
          break;

        case AttemptsGradeMethod.LAST_ATTEMPT:
          // Consider completed if any attempt is completed (last attempt)
          isLessonCompleted = true;
          break;

        case AttemptsGradeMethod.AVERAGE:
          // Consider completed if average score meets passing criteria
          if (lesson.passingMarks && lesson.totalMarks) {
            const averageScore = lessonAttempts.reduce((sum, attempt) => sum + (attempt.score || 0), 0) / lessonAttempts.length;
            const averagePercentage = (averageScore / lesson.totalMarks) * 100;
            isLessonCompleted = averagePercentage >= (lesson.passingMarks / lesson.totalMarks) * 100;
          } else {
            // If no passing criteria, consider completed if any attempt exists
            isLessonCompleted = true;
          }
          break;

        case AttemptsGradeMethod.HIGHEST:
          // Consider completed if highest score meets passing criteria
          if (lesson.passingMarks && lesson.totalMarks) {
            const highestScore = Math.max(...lessonAttempts.map(attempt => attempt.score || 0));
            const highestPercentage = (highestScore / lesson.totalMarks) * 100;
            isLessonCompleted = highestPercentage >= (lesson.passingMarks / lesson.totalMarks) * 100;
          } else {
            // If no passing criteria, consider completed if any attempt exists
            isLessonCompleted = true;
          }
          break;

        default:
          // Default behavior: consider completed if any attempt is completed
          isLessonCompleted = true;
          break;
      }

      if (isLessonCompleted) {
        completedLessonsCount++;
      }
    }

    return completedLessonsCount;
  }

  /**
   * Helper method to update module tracking
   */
  private async updateModuleTracking(moduleId: string, userId: string, tenantId: string, organisationId: string): Promise<void> {
    
    try {
    // Get module
    const module = await this.moduleRepository.findOne({
      where: { 
        moduleId,
        tenantId,
        organisationId,
        status: Not(ModuleStatus.ARCHIVED as any)
      } as FindOptionsWhere<Module>,
    });
    
    if (!module) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.MODULE_NOT_FOUND);
    }

    // Get or create module tracking
    let moduleTrack = await this.moduleTrackRepository.findOne({
      where: { 
        moduleId,
        userId,
        tenantId,
        organisationId
      } as FindOptionsWhere<ModuleTrack>,
    });

    if (!moduleTrack) {
      moduleTrack = this.moduleTrackRepository.create({
        moduleId,
        userId,
        tenantId,
        organisationId,
        status: ModuleTrackStatus.INCOMPLETE,
        completedLessons: 0,
        totalLessons: 0,
        progress: 0,
      });
    }

    // Get all parent lessons in this module with considerForPassing = true
    const moduleLessons = await this.lessonRepository.find({
      where: { 
        moduleId,
        tenantId,
        organisationId,
        status: LessonStatus.PUBLISHED,
        considerForPassing: true,
        parentId: IsNull() // Only consider parent lessons for completion tracking
      } as FindOptionsWhere<Lesson>,
    });

    // Calculate completed lessons based on attemptsGrade
    const completedLessonsCount = await this.calculateCompletedLessonsBasedOnAttemptsGrade(
      moduleLessons,
      userId,
      null, // No courseId for module tracking
      tenantId,
      organisationId
    );

    // Update module tracking data
    moduleTrack.completedLessons = completedLessonsCount;
    moduleTrack.totalLessons = moduleLessons.length;
    moduleTrack.progress = moduleLessons.length > 0 ? Math.round((completedLessonsCount / moduleLessons.length) * 100) : 0;

    // Update module status based on completion
    if (completedLessonsCount === moduleLessons.length && moduleLessons.length > 0) {
      moduleTrack.status = ModuleTrackStatus.COMPLETED;
    } else {
      moduleTrack.status = ModuleTrackStatus.INCOMPLETE;
    }

    await this.moduleTrackRepository.save(moduleTrack);

    } catch (error) {
      this.logger.error(`Error updating module tracking for moduleId: ${moduleId}, userId: ${userId}`, error);
      throw new BadRequestException(RESPONSE_MESSAGES.ERROR.MODULE_TRACKING_ERROR);
    }
  }

  /**
   * Update lesson completion by event ID
   * @param eventId The event ID that maps to lesson.media.source
   * @param updateEventProgressDto The update data containing userId, status, and timeSpent
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   */
  async updateEventProgress(
    eventId: string,
    updateEventProgressDto: UpdateEventProgressDto,
    tenantId: string,
    organisationId: string
  ): Promise<LessonTrack> {
    try {
      // Find lesson by media.source matching the eventId
      const lesson = await this.lessonRepository.findOne({
        where: {
          tenantId,
          organisationId,
          status: LessonStatus.PUBLISHED,
          media: {
            source: eventId,
            tenantId,
            organisationId
          }
        } as FindOptionsWhere<Lesson>,
        relations: ['media']
      });

      if (!lesson) {
        throw new NotFoundException(RESPONSE_MESSAGES.ERROR.LESSON_NOT_FOUND);
      }

      // Find the last attempt for this lesson and user
      const lastAttempt = await this.lessonTrackRepository.findOne({
        where: {
          lessonId: lesson.lessonId,
          userId: updateEventProgressDto.userId,
          tenantId,
          organisationId
        } as FindOptionsWhere<LessonTrack>,
        order: {
          attempt: 'DESC'
        }
      });

      if (!lastAttempt) {
        throw new NotFoundException(RESPONSE_MESSAGES.ERROR.TRACKING_NOT_FOUND);
      }

      // Update the attempt with the provided data
      const updateData: Partial<LessonTrack> = {
        status: updateEventProgressDto.status || TrackingStatus.COMPLETED,
        endDatetime: new Date(),
        updatedBy: updateEventProgressDto.userId
      };

      // Add timeSpent if provided
      if (updateEventProgressDto.timeSpent !== undefined) {
        updateData.timeSpent = (lastAttempt.timeSpent || 0) + updateEventProgressDto.timeSpent;
      }

      // Update completion percentage to 100% if marking as completed
      if (updateData.status === TrackingStatus.COMPLETED) {
        updateData.completionPercentage = 100;
      }

      // Apply updates
      Object.assign(lastAttempt, updateData);

      // Save the updated attempt
      const updatedAttempt = await this.lessonTrackRepository.save(lastAttempt);

      // Attach lesson to attempt to avoid redundant query in async update
      (updatedAttempt as any).lesson = lesson;

      // Update course and module tracking asynchronously (fire and forget) to avoid blocking response
      // Skip expensive operations for incomplete status - no need to recalculate course completion
      if (updatedAttempt.courseId && updatedAttempt.status !== TrackingStatus.INCOMPLETE) {
        this.updateCourseAndModuleTracking(updatedAttempt, tenantId, organisationId)
          .catch(err => this.logger.error('Failed to update course/module tracking asynchronously', err));
      }

      // Remove lesson relation from response to reduce payload size (lesson was loaded only for internal use)
      const { lesson: _lesson, course: _course, ...response } = updatedAttempt;
      return response as unknown as LessonTrack;
    } catch (error) {
      this.logger.error(`Error updating event progress for eventId: ${eventId}, userId: ${updateEventProgressDto.userId}`, error);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException('Error updating lesson progress');
    }
  }

  /**
   * Recalculate progress for course tracking and module tracking
   * Updates noOfLessons in course_track and totalLessons in module_track
   * based on lessons with considerForPassing = true and status = 'published'
   * OPTIMIZED: Uses CTEs and JOINs for better performance, single transaction, and returns affected row counts
   * @param courseId The course ID to recalculate progress for
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   */
  async recalculateProgress(
    courseId: string,
    tenantId: string,
    organisationId: string
  ): Promise<{ success: boolean; message: string; courseTrackUpdated: number; moduleTrackUpdated: number }> {
    const startTime = Date.now();
    try {
      this.logger.log(`[PERF] Recalculating progress for courseId: ${courseId}, tenantId: ${tenantId}, organisationId: ${organisationId}`);

      // OPTIMIZED: Verify course exists and get module IDs in parallel
      const [course, moduleIds] = await Promise.all([
        this.courseRepository.findOne({
          where: {
            courseId,
            tenantId,
            organisationId
          } as FindOptionsWhere<Course>,
          select: ['courseId']
        }),
        this.moduleRepository
          .createQueryBuilder('module')
          .select('module.moduleId')
          .where('module.courseId = :courseId', { courseId })
          .andWhere('module.tenantId = :tenantId', { tenantId })
          .andWhere('module.organisationId = :organisationId', { organisationId })
          .getMany()
      ]);

      if (!course) {
        throw new NotFoundException(RESPONSE_MESSAGES.ERROR.COURSE_NOT_FOUND);
      }

      const moduleIdList = moduleIds.map(m => m.moduleId);

      // OPTIMIZED: Use CTEs with LEFT JOIN LATERAL to ensure ALL tracks are updated
      // This ensures every course_track row is updated, even if there are no lessons
      const courseUpdateSql = `
        UPDATE course_track ct
        SET "noOfLessons" = COALESCE((
          SELECT COUNT(l."lessonId")::integer
          FROM lessons l
          WHERE l."courseId" = ct."courseId"
            AND l."tenantId" = ct."tenantId"
            AND l."organisationId" = ct."organisationId"
            AND l.status = 'published'
            AND l."considerForPassing" = true
        ), 0)
        WHERE ct."tenantId" = $1
          AND ct."organisationId" = $2
          AND ct."courseId" = $3
      `;

      // Build module update query - use correlated subquery to ensure ALL tracks are updated
      let moduleUpdateSql: string;
      let moduleUpdateParams: any[];
      
      if (moduleIdList.length === 0) {
        // No modules to update
        moduleUpdateSql = `SELECT 0 as count`;
        moduleUpdateParams = [];
      } else {
        // OPTIMIZED: Use CTE to calculate lesson counts once, ensures ALL records updated
        // Parameters: $1=tenantId, $2=organisationId, $3+ = moduleIds
        // Updates totalLessons and calculates progress based on completedLessons / totalLessons * 100
        // Performance: Calculates lesson count ONCE per module (instead of 3 times per row)
        // Uses DISTINCT module_track.moduleId to ensure all records are updated, even modules with no lessons
        const moduleIdPlaceholders = moduleIdList.map((_, index) => `$${index + 3}`).join(', ');
        moduleUpdateSql = `
          WITH target_modules AS (
            SELECT DISTINCT "moduleId"
            FROM module_track
            WHERE "moduleId" IN (${moduleIdPlaceholders})
              AND "tenantId" = $1
              AND "organisationId" = $2
          ),
          lesson_counts AS (
            SELECT 
              l."moduleId",
              COUNT(l."lessonId")::integer as total
            FROM lessons l
            WHERE l."moduleId" IN (${moduleIdPlaceholders})
              AND l."tenantId" = $1
              AND l."organisationId" = $2
              AND l.status = 'published'
              AND l."considerForPassing" = true
            GROUP BY l."moduleId"
          ),
          module_lesson_counts AS (
            SELECT 
              tm."moduleId",
              COALESCE(lc.total, 0) as total
            FROM target_modules tm
            LEFT JOIN lesson_counts lc ON tm."moduleId" = lc."moduleId"
          )
          UPDATE module_track mt
          SET 
            "totalLessons" = mlc.total,
            "progress" = CASE
              WHEN mlc.total > 0
              THEN ROUND((mt."completedLessons"::numeric / mlc.total::numeric) * 100)
              ELSE 0
            END
          FROM module_lesson_counts mlc
          WHERE mt."moduleId" = mlc."moduleId"
            AND mt."moduleId" IN (${moduleIdPlaceholders})
            AND mt."tenantId" = $1
            AND mt."organisationId" = $2
        `;
        moduleUpdateParams = [tenantId, organisationId, ...moduleIdList];
      }

      // OPTIMIZED: Execute both updates in parallel
      await Promise.all([
        this.courseTrackRepository.query(courseUpdateSql, [
          tenantId,
          organisationId,
          courseId
        ]),
        moduleIdList.length > 0 
          ? this.moduleTrackRepository.query(moduleUpdateSql, moduleUpdateParams)
          : Promise.resolve([])
      ]);

      // Get total counts of all matching records (matches original behavior)
      // This counts ALL course_track and module_track records for the course, not just updated ones
      const [courseTrackCount, moduleTrackCount] = await Promise.all([
        this.courseTrackRepository.count({
          where: {
            courseId,
            tenantId,
            organisationId
          } as FindOptionsWhere<CourseTrack>,
        }),
        moduleIdList.length > 0
          ? this.moduleTrackRepository.count({
              where: {
                moduleId: In(moduleIdList),
                tenantId,
                organisationId
              } as FindOptionsWhere<ModuleTrack>,
            })
          : Promise.resolve(0)
      ]);

      const courseTrackUpdated = courseTrackCount;
      const moduleTrackUpdated = moduleTrackCount;

      const executionTime = Date.now() - startTime;
      this.logger.log(
        `[PERF] Progress recalculation completed in ${executionTime}ms. Course tracks: ${courseTrackUpdated}, Module tracks: ${moduleTrackUpdated}`
      );

      return {
        success: true,
        message: `Progress recalculated successfully. Updated ${courseTrackUpdated} course track(s) and ${moduleTrackUpdated} module track(s).`,
        courseTrackUpdated: courseTrackUpdated,
        moduleTrackUpdated: moduleTrackUpdated
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.logger.error(`[PERF] Error recalculating progress for courseId: ${courseId} (took ${executionTime}ms)`, error);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException('Error recalculating progress');
    }
  }

  /**
   * Get user journey: enrolled courses for user in cohort with event-attendance flags
   * and final-assessment pass/fail on progressDetail.assessmentOutcome.
   */
  async getUserJourney(
    dto: UserJourneyDto,
    tenantId: string,
    organisationId: string,
  ): Promise<UserJourneyResponseDto> {
    const offset = Math.max(0, dto.offset ?? 0);
    const limit = Math.min(100, Math.max(1, dto.limit ?? 10));

    if (!dto.cohortId && !dto.pathwayId) {
      throw new BadRequestException('Either cohortId or pathwayId must be provided.');
    }

    if (dto.cohortId && dto.pathwayId) {
      throw new BadRequestException(
        'Either cohortId or pathwayId must be provided, but not both.',
      );
    }

    const { courses, totalElements } = await this.enrollmentsService.usersEnrolledCourses(
      {
        userId: dto.userId,
        cohortId: dto.cohortId,
        pathwayId: dto.pathwayId,
        limit,
        offset,
      },
      tenantId,
      organisationId,
    );

    if (courses.length === 0) {
      return {
        courses: [],
        totalElements,
        offset,
        limit,
      };
    }

    const courseIds = courses.map((c) => c.courseId);

    const [cachedEventLessonIdResults, courseTracks, assessmentOutcomeByCourse] =
      await Promise.all([
        Promise.all(courseIds.map((id) => this.cacheService.getCourseEventLessons(id))),
        this.courseTrackRepository.find({
          where: {
            userId: dto.userId,
            courseId: In(courseIds),
            tenantId,
            organisationId,
          },
          select: [
            'courseId',
            'status',
            'completedLessons',
            'noOfLessons',
            'lastAccessedDate',
            'certificateIssued',
          ],
        }),
        this.determineCourseOutcomes(
          dto.userId,
          courseIds,
          tenantId,
          organisationId,
        ),
      ]);

    const courseToEventLessonIds = new Map<string, string[]>();
    const courseIdsToFetch: string[] = [];

    courseIds.forEach((id, index) => {
      const cached = cachedEventLessonIdResults[index];
      if (cached) {
        courseToEventLessonIds.set(id, cached);
      } else {
        courseIdsToFetch.push(id);
      }
    });

    if (courseIdsToFetch.length > 0) {
      const eventLessonsFromDb = await this.lessonRepository.find({
        where: {
          courseId: In(courseIdsToFetch),
          format: LessonFormat.EVENT,
          status: LessonStatus.PUBLISHED,
          tenantId,
          organisationId,
        },
        select: ['lessonId', 'courseId'],
      });

      const freshCourseToEventLessonIds = new Map<string, string[]>();
      for (const l of eventLessonsFromDb) {
        const list = freshCourseToEventLessonIds.get(l.courseId) ?? [];
        list.push(l.lessonId);
        freshCourseToEventLessonIds.set(l.courseId, list);
      }

      for (const id of courseIdsToFetch) {
        const list = freshCourseToEventLessonIds.get(id) ?? [];
        courseToEventLessonIds.set(id, list);
        this.cacheService.setCourseEventLessons(id, list).catch((err) => {
          this.logger.warn(`Failed to set event lessons cache for course ${id}: ${err.message}`);
        });
      }
    }

    const courseTrackByCourseId = new Map(courseTracks.map((t) => [t.courseId, t]));

    const allEventLessonIds = Array.from(courseToEventLessonIds.values()).flat();
    let completedEventLessonIds = new Set<string>();

    if (allEventLessonIds.length > 0) {
      const completed = await this.lessonTrackRepository.find({
        where: {
          userId: dto.userId,
          lessonId: In(allEventLessonIds),
          status: TrackingStatus.COMPLETED,
          tenantId,
          organisationId,
        },
        select: ['lessonId'],
      });
      completedEventLessonIds = new Set(completed.map((r) => r.lessonId));
    }

    const resultCourses: UserJourneyItemDto[] = courses.map((course) => {
      const eventLessonIds = courseToEventLessonIds.get(course.courseId) ?? [];
      const totalEventLessons = eventLessonIds.length;
      const isAttendedOneEvent =
        totalEventLessons > 0 &&
        eventLessonIds.some((id) => completedEventLessonIds.has(id));
      const track = courseTrackByCourseId.get(course.courseId);
      const noOfLessons = track?.noOfLessons ?? 0;
      const completedLessons = track?.completedLessons ?? 0;
      const progressPct =
        noOfLessons > 0 ? Math.round((completedLessons / noOfLessons) * 100) : 0;
      const courseTrackStatus = track?.status ?? TrackingStatus.NOT_STARTED;
      const progressDetail = {
        courseTrackStatus,
        completedLessons,
        noOfLessons,
        progress: progressPct,
        lastAccessedDate: track?.lastAccessedDate?.toISOString() ?? null,
        certificateIssued: track?.certificateIssued ?? false,
        assessmentOutcome: assessmentOutcomeByCourse.get(course.courseId) ?? null,
      };
      return {
        courseId: course.courseId,
        name: course.title,
        title: course.title,
        alias: course.alias,
        shortDescription: course.shortDescription,
        description: course.description,
        image: course.image,
        status: courseTrackStatus,
        progress: progressPct,
        params: course.params,
        ordering: course.ordering,
        totalEventLessons,
        isAttendedOneEvent,
        progressDetail,
      };
    });

    return {
      courses: resultCourses,
      totalElements,
      offset,
      limit,
    };
  }

  /**
   * Returns the media `source` string when it is a bare UUID (used as external test id); otherwise null.
   */
  private extractUuidFromMediaSource(source: string | null | undefined): string | null {
    if (source == null || typeof source !== 'string') {
      return null;
    }
    const s = source.trim();
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRe.test(s) ? s : null;
  }

  /**
   * For each course, finds the published root assessment lesson with highest ordering and pairs it with
   * the test id parsed from that lesson’s media source (end-of-course test used on user journey).
   */
  private async getAssessementLessonByCourse(
    courseIds: string[],
    tenantId: string,
    organisationId: string,
  ): Promise<Map<string, { lesson: Lesson; testId: string | null }>> {
    const result = new Map<string, { lesson: Lesson; testId: string | null }>();
    if (courseIds.length === 0) {
      return result;
    }
    const rows = await this.lessonRepository.find({
      where: {
        courseId: In(courseIds),
        format: LessonFormat.ASSESSMENT,
        status: LessonStatus.PUBLISHED,
        tenantId,
        organisationId,
        parentId: IsNull(),
      },
      relations: ['media'],
    });
    for (const l of rows) {
      const cur = result.get(l.courseId);
      if (!cur || (l.ordering ?? 0) > (cur.lesson.ordering ?? 0)) {
        const testId = this.extractUuidFromMediaSource(l.media?.source);
        result.set(l.courseId, { lesson: l, testId });
      }
    }
    return result;
  }

  /** Assessment service `tests.gradingType` value that uses import/review outcome semantics. */
  private static readonly USER_ASSESSMENT_GRADING_TYPE = 'assessment';

  /**
   * Calls assessment internal `POST {ASSESSMENT_SERVICE_URL}/internal/attempts/user/result-status`
   * (body: userId, testId, tenantId, organisationId; no auth headers). Must match assessment
   * InternalUserResultController. Override with ASSESSMENT_USER_RESULT_PATH if the route differs.
   * If this call fails, every course falls back to FALLBACK mode (any completed attempt → pass).
   */
  private async getScoreByAssessmentTest(
    userId: string,
    testIds: string[],
    tenantId: string,
    organisationId: string,
  ): Promise<Map<string, { isImported: boolean; gradingType: string | null }>> {
    const map = new Map<string, { isImported: boolean; gradingType: string | null }>();
    const unique = [...new Set(testIds.filter(Boolean))];
    const base = this.configService.get<string>('ASSESSMENT_SERVICE_URL', '').replace(/\/$/, '');
    const path = this.configService
      .get<string>('ASSESSMENT_USER_RESULT_PATH', 'internal/attempts/user/result-status')
      .replace(/^\/+/, '');
    if (!base || unique.length === 0) {
      return map;
    }
    const url = `${base}/${path}`;
    await Promise.all(
      unique.map(async (testId) => {
        try {
          const { data } = await axios.post(
            url,
            { userId, testId, tenantId, organisationId },
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
          );
          const payload = data?.result ?? data;
          if (payload && typeof payload.isImported === 'boolean') {
            const gradingType =
              payload.gradingType != null &&
              typeof payload.gradingType === 'string' &&
              payload.gradingType.length > 0
                ? payload.gradingType
                : null;
            map.set(testId, { isImported: payload.isImported, gradingType });
          }
        } catch (e: any) {
          this.logger.warn(
            `getScoreByAssessmentTest testId=${testId}: ${e?.message ?? e}`,
          );
        }
      }),
    );
    return map;
  }

  /**
   * True when the lesson track is submitted and the stored score is below the lesson’s passing marks
   * (used when a final result exists externally but pass/fail is not in the HTTP payload).
   */
  private isBelowPassingThreshold(
    attempt: LessonTrack,
    lesson: Lesson,
  ): boolean {
    if (attempt.status === TrackingStatus.COMPLETED) {
      return false;
    }
    if (
      lesson.totalMarks &&
      lesson.passingMarks != null &&
      attempt.score != null &&
      attempt.status === TrackingStatus.SUBMITTED
    ) {
      const pct = (attempt.score / lesson.totalMarks) * 100;
      const passPct = (lesson.passingMarks / lesson.totalMarks) * 100;
      if (pct < passPct) {
        return true;
      }
    }
    return false;
  }

  /**
   * Maps one lesson_track row plus assessment `isImported` to pass | fail | submitted | null.
   * Used for `formal_assessment` and `fallback` outcome modes (see USER_OUTCOME_MODE); not used on the
   * non_formal_grading submitted-only path. `assessmentIsImported`: undefined skips import branch; null =
   * unknown fetch; boolean from assessment service for formal tests.
   */
  private determineLessonPassStatus(
    graded: LessonTrack,
    lesson: Lesson,
    assessmentIsImported: boolean | null | undefined,
  ): FinalAssessmentOutcome {
    if (graded.status === TrackingStatus.COMPLETED) {
      return 'pass';
    }
    if (graded.status === TrackingStatus.SUBMITTED && assessmentIsImported !== undefined) {
      if (assessmentIsImported === null) {
        return this.evaluateAttemptOutcome(graded, lesson);
      }
      if (assessmentIsImported === false) {
        return 'submitted';
      }
      if (this.isBelowPassingThreshold(graded, lesson)) {
        return 'fail';
      }
      return 'pass';
    }
    return this.evaluateAttemptOutcome(graded, lesson);
  }

  /**
   * Chooses journey `assessmentOutcome` from attempts; see USER_OUTCOME_MODE.
   */
  private determineLessonOutcomeFromAttempts(
    attempts: LessonTrack[],
    lesson: Lesson,
    assessmentIsImported: boolean | null | undefined,
    mode: UserOutcomeMode,
  ): FinalAssessmentOutcome {
    if (!attempts.length) {
      return null;
    }

    // Quiz-like tests: do not surface pass/fail here (see USER_OUTCOME_MODE.non_formal_grading).
    if (mode === USER_OUTCOME_MODE.NON_FORMAL_GRADING) {
      if (attempts.some((a) => a.status === TrackingStatus.COMPLETED)) {
        return null;
      }
      const graded = attempts.at(-1)!;
      if (graded.status === TrackingStatus.SUBMITTED) {
        return 'submitted';
      }
      return null;
    }

    // formal_assessment + fallback: any completed row → pass, else import-aware rules.
    if (attempts.some((a) => a.status === TrackingStatus.COMPLETED)) {
      return 'pass';
    }
    const graded = attempts.at(-1)!;
    return this.determineLessonPassStatus(graded, lesson, assessmentIsImported);
  }

  /**
   * Outcome using only LMS lesson_track (no external import flag): fail if below passing, else pass if completed.
   */
  private evaluateAttemptOutcome(
    attempt: LessonTrack,
    lesson: Lesson,
  ): FinalAssessmentOutcome {
    if (this.isBelowPassingThreshold(attempt, lesson)) {
      return 'fail';
    }
    if (attempt.status === TrackingStatus.COMPLETED) {
      return 'pass';
    }
    return null;
  }

  /**
   * Builds courseId → assessmentOutcome: picks final assessment lesson per course, calls assessment
   * internal result-status in parallel, then branches on USER_OUTCOME_MODE.
   */
  private async determineCourseOutcomes(
    userId: string,
    courseIds: string[],
    tenantId: string,
    organisationId: string,
  ): Promise<Map<string, FinalAssessmentOutcome>> {
    const out = new Map<string, FinalAssessmentOutcome>();
    for (const cid of courseIds) {
      out.set(cid, null);
    }

    const finalByCourse = await this.getAssessementLessonByCourse(
      courseIds,
      tenantId,
      organisationId,
    );
    if (finalByCourse.size === 0) {
      return out;
    }

    const testIds: string[] = [];
    for (const ctx of finalByCourse.values()) {
      if (ctx.testId) {
        testIds.push(ctx.testId);
      }
    }
    const assessmentByTestId = await this.getScoreByAssessmentTest(
      userId,
      testIds,
      tenantId,
      organisationId,
    );

    const lessonIds = [...finalByCourse.values()].map((c) => c.lesson.lessonId);
    const tracks = await this.lessonTrackRepository.find({
      where: {
        userId,
        lessonId: In(lessonIds),
        tenantId,
        organisationId,
      },
      order: { attempt: 'ASC' },
    });

    const byLesson = new Map<string, LessonTrack[]>();
    for (const t of tracks) {
      if (!byLesson.has(t.lessonId)) {
        byLesson.set(t.lessonId, []);
      }
      byLesson.get(t.lessonId)!.push(t);
    }

    for (const [courseId, ctx] of finalByCourse) {
      const attempts = byLesson.get(ctx.lesson.lessonId) ?? [];
      let assessmentIsImported: boolean | null | undefined;
      let mode: UserOutcomeMode;
      if (ctx.testId) {
        const meta = assessmentByTestId.get(ctx.testId);
        if (meta) {
          if (meta.gradingType === TrackingService.USER_ASSESSMENT_GRADING_TYPE) {
            // Formal graded assessment: use import + pass/fail/submitted pipeline.
            assessmentIsImported = meta.isImported;
            mode = USER_OUTCOME_MODE.FORMAL_ASSESSMENT;
          } else if (meta.gradingType != null && meta.gradingType !== '') {
            // Quiz / feedback / reflection — not the same semantics as formal assessment outcome.
            assessmentIsImported = undefined;
            mode = USER_OUTCOME_MODE.NON_FORMAL_GRADING;
          } else {
            // Response had no usable gradingType string; keep prior combined behavior.
            assessmentIsImported = meta.isImported;
            mode = USER_OUTCOME_MODE.FALLBACK;
          }
        } else {
          // Assessment call failed or returned nothing for this testId.
          assessmentIsImported = null;
          mode = USER_OUTCOME_MODE.FALLBACK;
        }
      } else {
        // Lesson media has no UUID test link; LMS-only side of rules.
        assessmentIsImported = undefined;
        mode = USER_OUTCOME_MODE.FALLBACK;
      }
      const outcome = this.determineLessonOutcomeFromAttempts(
        attempts,
        ctx.lesson,
        assessmentIsImported,
        mode,
      );
      if (outcome !== null) {
        out.set(courseId, outcome);
      }
    }

    return out;
  }
}