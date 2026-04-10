import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, Not, IsNull, In } from 'typeorm';
import { CourseStatus } from '../courses/entities/course.entity';
import { LessonStatus } from '../lessons/entities/lesson.entity';
import { EnrollmentStatus } from '../enrollments/entities/user-enrollment.entity';
import { Course } from '../courses/entities/course.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { Module as CourseModule } from '../modules/entities/module.entity';
import {
  CourseTrack,
  TrackingStatus,
} from '../tracking/entities/course-track.entity';
import { LessonTrack } from '../tracking/entities/lesson-track.entity';
import { UserEnrollment } from '../enrollments/entities/user-enrollment.entity';
import { CourseReportDto } from './dto/course-report.dto';
import {
  LessonCompletionStatusDto,
  LessonCompletionStatusResponseDto,
} from './dto/lesson-completion-status.dto';
import { UpdateTestProgressDto } from './dto/update-test-progress.dto';
import { RESPONSE_MESSAGES } from '../common/constants/response-messages.constant';
import { AttemptsGradeMethod } from '../lessons/entities/lesson.entity';
import { Media } from '../media/entities/media.entity';
import { TrackingService } from '../tracking/tracking.service';
import { CacheService } from '../cache/cache.service';

@Injectable()
export class AspireLeaderService {
  private readonly logger = new Logger(AspireLeaderService.name);

  constructor(
    @InjectRepository(Course)
    private readonly courseRepository: Repository<Course>,
    @InjectRepository(Lesson)
    private readonly lessonRepository: Repository<Lesson>,
    @InjectRepository(CourseTrack)
    private readonly courseTrackRepository: Repository<CourseTrack>,
    @InjectRepository(LessonTrack)
    private readonly lessonTrackRepository: Repository<LessonTrack>,
    @InjectRepository(UserEnrollment)
    private readonly userEnrollmentRepository: Repository<UserEnrollment>,
    @Inject(TrackingService)
    private readonly trackingService: TrackingService,
    @InjectRepository(Media)
    private readonly mediaRepository: Repository<Media>,
    @InjectRepository(CourseModule)
    private readonly moduleRepository: Repository<CourseModule>,
    private readonly configService: ConfigService,
    private readonly cacheService: CacheService,
  ) { }

  /**
   * Generate course report (course-level or lesson-level)
   */
  async generateCourseReport(
    reportDto: CourseReportDto,
    tenantId: string,
    organisationId: string,
    authorization: string,
  ): Promise<any> {
    const startTime = Date.now();
    this.logger.log(
     `Generating course report for courseId: ${reportDto.courseId}, cohortId: ${reportDto.cohortId ?? 'n/a'}, pathwayId: ${reportDto.pathwayId ?? 'n/a'}`,
    );

    // Validate course exists
    const course = await this.courseRepository.findOne({
      where: {
        courseId: reportDto.courseId,
        tenantId,
        organisationId,
        status: Not(CourseStatus.ARCHIVED),
      } as FindOptionsWhere<Course>,
    });

    if (!course) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.COURSE_NOT_FOUND);
    }

    // Check if lesson-level report is requested
    let result: any;
    if (reportDto.lessonId) {
      result = await this.generateLessonLevelReport(
        reportDto,
        course,
        tenantId,
        organisationId,
        authorization,
      );
    } else {
      result = await this.generateCourseLevelReport(
        reportDto,
        course,
        tenantId,
        organisationId,
        authorization,
      );
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `Report generated in ${duration}ms for courseId: ${reportDto.courseId}`,
    );

    return result;
  }

  /**
   * Generate course-level report with optimized JOINs
   */
  private async generateCourseLevelReport(
    reportDto: CourseReportDto,
    course: Course,
    tenantId: string,
    organisationId: string,
    authorization: string,
  ): Promise<any> {
    // Build query with filters
    const queryBuilder = this.courseTrackRepository
      .createQueryBuilder('courseTrack')
      .innerJoinAndSelect('courseTrack.course', 'course')
      .leftJoin(
        'user_enrollments',
        'enrollment',
        'enrollment.courseId = courseTrack.courseId AND enrollment.userId = courseTrack.userId AND enrollment.tenantId = courseTrack.tenantId',
      )
      .addSelect([
        'enrollment.enrollmentId',
        'enrollment.userId',
        'enrollment.status',
        'enrollment.enrolledAt',
        'enrollment.endTime',
      ])
      .where('courseTrack.courseId = :courseId', {
        courseId: reportDto.courseId,
      })
      .andWhere('courseTrack.tenantId = :tenantId', { tenantId })
      .andWhere('courseTrack.organisationId = :organisationId', {
        organisationId,
      })
      .andWhere('(enrollment.status IS NULL OR enrollment.status != :status)', {
        status: EnrollmentStatus.ARCHIVED,
      });

    // Apply status filter (course tracking status)
    if (reportDto.status) {
      queryBuilder.andWhere('courseTrack.status = :trackingStatus', {
        trackingStatus: reportDto.status,
      });
    }
    // Apply certificate issued filter
    if (reportDto.certificateIssued !== undefined) {
      queryBuilder.andWhere(
        'courseTrack.certificateIssued = :certificateIssued',
        { certificateIssued: reportDto.certificateIssued },
      );
    }

    const enrollmentData = await queryBuilder
      .orderBy(
        this.getSortField(reportDto.sortBy || 'progress', true),
        (reportDto.orderBy?.toUpperCase() as 'ASC' | 'DESC') || 'DESC',
      )
      .addOrderBy('courseTrack.lastAccessedDate', 'DESC') // Secondary sort for consistent ordering
      .skip(reportDto.offset || 0)
      .take(reportDto.limit || 10)
      .getMany();

    // Get total count for pagination with same filters
    const countQueryBuilder = this.courseTrackRepository
      .createQueryBuilder('courseTrack')
      .leftJoin(
        'user_enrollments',
        'enrollment',
        'enrollment.courseId = courseTrack.courseId AND enrollment.userId = courseTrack.userId AND enrollment.tenantId = courseTrack.tenantId',
      )
      .where('courseTrack.courseId = :courseId', {
        courseId: reportDto.courseId,
      })
      .andWhere('courseTrack.tenantId = :tenantId', { tenantId })
      .andWhere('courseTrack.organisationId = :organisationId', {
        organisationId,
      })
      .andWhere('(enrollment.status IS NULL OR enrollment.status != :status)', {
        status: EnrollmentStatus.ARCHIVED,
      });

    // Apply same filters to count query
    if (reportDto.status) {
      countQueryBuilder.andWhere('courseTrack.status = :trackingStatus', {
        trackingStatus: reportDto.status,
      });
    }

    if (reportDto.certificateIssued !== undefined) {
      countQueryBuilder.andWhere(
        'courseTrack.certificateIssued = :certificateIssued',
        { certificateIssued: reportDto.certificateIssued },
      );
    }

    const totalCount = await countQueryBuilder.getCount();

    if (enrollmentData.length === 0) {
      return {
        data: [],
        totalElements: totalCount,
        offset: reportDto.offset || 0,
        limit: reportDto.limit || 10,
      };
    }

    const userIds = enrollmentData.map((enrollment) => enrollment.userId);

    // Fetch user data from external API - limit matches the number of users we're requesting
    const userData = await this.fetchUserData(
      userIds,
      tenantId,
      organisationId,
      authorization,
    );

    // Create a map of user data for efficient lookup while preserving order
    const userDataMap = new Map(userData.map((user) => [user.userId, user]));

    // Combine data and create report items - maintain the original database order
    const reportItems: any[] = [];

    for (const courseTrackData of enrollmentData) {
      const user = userDataMap.get(courseTrackData.userId);
      const course = courseTrackData['course'];
      const enrollment = courseTrackData['enrollment'];

      if (user) {
        // Calculate progress
        const progress =
          courseTrackData.noOfLessons > 0
            ? Math.round(
              (courseTrackData.completedLessons /
                courseTrackData.noOfLessons) *
              100,
            )
            : 0;

        reportItems.push({
          ...user,
          courseId: course.courseId,
          courseTitle: course.title,
          courseStatus: course.status,
          courseFeatured: course.featured,
          courseFree: course.free,
          courseStartDate: course.startDatetime?.toISOString(),
          courseEndDate: course.endDatetime?.toISOString(),
          // Course Track fields
          courseTrackId: courseTrackData.courseTrackId,
          courseTrackStartDate: courseTrackData.startDatetime?.toISOString(),
          courseTrackEndDate: courseTrackData.endDatetime?.toISOString(),
          noOfLessons: courseTrackData.noOfLessons || 0,
          completedLessons: courseTrackData.completedLessons || 0,
          courseTrackStatus: courseTrackData.status,
          lastAccessedDate: courseTrackData.lastAccessedDate?.toISOString(),
          certificateIssued: courseTrackData.certificateIssued,
          certificateIssuedDate: course.certificateGenDateTime?.toISOString(),
          // Enrollment fields
          enrollmentId: enrollment?.enrollmentId,
          enrollmentStatus: enrollment?.status,
          enrolledDate: enrollment?.enrolledAt?.toISOString(),
          completedDate: enrollment?.endTime?.toISOString(),
          progress:
            (courseTrackData.completedLessons / courseTrackData.noOfLessons) *
            100 || 0,
        });
      }
    }

    // No need to apply pagination again since it's already applied at database level
    return {
      data: reportItems,
      totalElements: totalCount,
      offset: reportDto.offset || 0,
      limit: reportDto.limit || 10,
    };
  }

  /**
   * Generate lesson-level report with optimized JOINs
   */
  private async generateLessonLevelReport(
    reportDto: CourseReportDto,
    course: Course,
    tenantId: string,
    organisationId: string,
    authorization: string,
  ): Promise<any> {
    // Validate lesson exists
    const lesson = await this.lessonRepository.findOne({
      where: {
        lessonId: reportDto.lessonId,
        courseId: reportDto.courseId,
        tenantId,
        organisationId,
        status: Not(LessonStatus.ARCHIVED),
      } as FindOptionsWhere<Lesson>,
    });

    if (!lesson) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.LESSON_NOT_FOUND);
    }

    // Query with INNER JOIN lesson track and course, LEFT JOIN with enrollment
    const enrollmentData = await this.lessonTrackRepository
      .createQueryBuilder('lessonTrack')
      .innerJoinAndSelect('lessonTrack.course', 'course')
      .leftJoin(
        'user_enrollments',
        'enrollment',
        'enrollment.courseId = lessonTrack.courseId AND enrollment.userId = lessonTrack.userId AND enrollment.tenantId = lessonTrack.tenantId',
      )
      .addSelect([
        'enrollment.enrollmentId',
        'enrollment.userId',
        'enrollment.status',
        'enrollment.enrolledAt',
        'enrollment.endTime',
      ])
      .where('lessonTrack.lessonId = :lessonId', {
        lessonId: reportDto.lessonId,
      })
      .andWhere('lessonTrack.courseId = :courseId', {
        courseId: reportDto.courseId,
      })
      .andWhere('lessonTrack.tenantId = :tenantId', { tenantId })
      .andWhere('lessonTrack.organisationId = :organisationId', {
        organisationId,
      })
      .andWhere('(enrollment.status IS NULL OR enrollment.status != :status)', {
        status: EnrollmentStatus.ARCHIVED,
      })
      .orderBy(
        this.getSortField(reportDto.sortBy || 'progress', false),
        (reportDto.orderBy?.toUpperCase() as 'ASC' | 'DESC') || 'DESC',
      )
      .addOrderBy('lessonTrack.updatedAt', 'DESC') // Tertiary sort by last update time
      .skip(reportDto.offset || 0)
      .take(reportDto.limit || 10)
      .getMany();

    // Get total count for pagination
    const totalCount = await this.lessonTrackRepository
      .createQueryBuilder('lessonTrack')
      .leftJoin(
        'user_enrollments',
        'enrollment',
        'enrollment.courseId = lessonTrack.courseId AND enrollment.userId = lessonTrack.userId AND enrollment.tenantId = lessonTrack.tenantId',
      )
      .where('lessonTrack.lessonId = :lessonId', {
        lessonId: reportDto.lessonId,
      })
      .andWhere('lessonTrack.courseId = :courseId', {
        courseId: reportDto.courseId,
      })
      .andWhere('lessonTrack.tenantId = :tenantId', { tenantId })
      .andWhere('lessonTrack.organisationId = :organisationId', {
        organisationId,
      })
      .andWhere('(enrollment.status IS NULL OR enrollment.status != :status)', {
        status: EnrollmentStatus.ARCHIVED,
      })
      .getCount();

    if (enrollmentData.length === 0) {
      return {
        data: [],
        totalElements: 0,
        offset: reportDto.offset || 0,
        limit: reportDto.limit || 10,
      };
    }

    const userIds = enrollmentData.map((enrollment) => enrollment.userId);

    // Fetch user data from external API - limit matches the number of users we're requesting
    const userData = await this.fetchUserData(
      userIds,
      tenantId,
      organisationId,
      authorization,
    );

    // Create a map of user data for efficient lookup while preserving order
    const userDataMap = new Map(userData.map((user) => [user.userId, user]));

    // Combine data and create report items - maintain the original database order
    const reportItems: any[] = [];

    for (const lessonTrackData of enrollmentData) {
      const user = userDataMap.get(lessonTrackData.userId);
      const course = lessonTrackData['course'];
      const enrollment = lessonTrackData['enrollment'];

      if (user) {
        reportItems.push({
          // User fields
          ...user,
          // Course fields
          courseId: course.courseId,
          courseTitle: course.title,
          courseStatus: course.status,
          // Lesson fields
          lessonTitle: lesson.title,
          type: lesson.format,
          // Lesson Track fields
          lessonTrackId: lessonTrackData.lessonTrackId,
          attempt: lessonTrackData.attempt || 0,
          startedAt: lessonTrackData.startDatetime?.toISOString(),
          completedAt: lessonTrackData.endDatetime?.toISOString(),
          score: lessonTrackData.score || 0,
          lessonStatus: lessonTrackData.status,
          timeSpent: lessonTrackData.timeSpent || 0,
          completionPercentage: lessonTrackData.completionPercentage || 0,
        });
      }
    }

    // No need to apply pagination again since it's already applied at database level
    return {
      data: reportItems,
      totalElements: totalCount,
      offset: reportDto.offset || 0,
      limit: reportDto.limit || 10,
    };
  }

  /**
   * Fetch user data from external API
   */
  private async fetchUserData(
    userIds: string[],
    tenantId: string,
    organisationId: string,
    authorization: string,
  ): Promise<any[]> {
    try {
      const userServiceUrl = this.configService.get('USER_SERVICE_URL', '');

      if (!userServiceUrl) {
        throw new BadRequestException(
          RESPONSE_MESSAGES.ERROR.USER_SERVICE_URL_NOT_CONFIGURED,
        );
      }

      const response = await axios.post(
        `${userServiceUrl}/list`,
        {
          filters: { userId: userIds },
          limit: userIds.length,
          includeCustomFields: false,
        },
        {
          headers: {
            tenantid: tenantId,
            organisationId: organisationId,
            Authorization: authorization,
            'Content-Type': 'application/json',
          },
        },
      );

      // Handle the actual response format from the user service
      const userDetails = response.data.result?.getUserDetails || [];

      // Filter out audit fields from user data
      return userDetails.map((user: any) => {
        const {
          createdBy,
          updatedBy,
          createdAt,
          updatedAt,
          ...userWithoutAudit
        } = user;
        return userWithoutAudit;
      });
    } catch (error) {
      this.logger.error('Failed to fetch user data from external API', error);
      throw new BadRequestException(
        RESPONSE_MESSAGES.ERROR.FAILED_TO_FETCH_USER_DATA,
      );
    }
  }

  /**
   * Check lesson completion status for a cohort based on criteria
   */
  async checkLessonCompletionStatus(
    completionDto: LessonCompletionStatusDto,
    tenantId: string,
    organisationId: string,
  ): Promise<LessonCompletionStatusResponseDto> {
    const startTime = Date.now();
    this.logger.log(
      `Checking lesson completion status for cohortId: ${completionDto.cohortId}`,
    );

    // Find courses that have this cohortId in their params
    const cohortCourses = await this.courseRepository
      .createQueryBuilder('course')
      .where('course."tenantId" = :tenantId', { tenantId })
      .andWhere('course."organisationId" = :organisationId', { organisationId })
      .andWhere('course."status" = :status', { status: CourseStatus.PUBLISHED })
      .andWhere(`course."params"->>'cohortId' = :cohortId`, {
        cohortId: completionDto.cohortId,
      })
      .getMany();

    if (cohortCourses.length === 0) {
      throw new NotFoundException(
        `No any course found with cohortId: ${completionDto.cohortId}`,
      );
    }

    // Get course IDs for this cohort
    const cohortCourseIds = cohortCourses.map((course) => course.courseId);

    this.logger.log(
      `Found ${cohortCourses.length} courses for cohortId: ${completionDto.cohortId}`,
    );

    const criteriaResults: Array<{
      criterion: any;
      status: boolean;
      totalLessons: number;
      completedLessons: number;
      message: string;
    }> = [];
    let overallStatus = true;

    // Process each criterion
    for (const criterion of completionDto.criteria) {
      const result = await this.checkCriterionCompletion(
        cohortCourseIds,
        criterion,
        tenantId,
        organisationId,
        completionDto.userId,
      );

      criteriaResults.push(result);

      // Overall status is false if any criterion fails
      if (!result.status) {
        overallStatus = false;
      }
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `Lesson completion status checked in ${duration}ms for cohortId: ${completionDto.cohortId}`,
    );

    return {
      overallStatus,
      criteriaResults,
    };
  }

  /**
   * Check completion status for a single criterion across multiple courses
   */
  private async checkCriterionCompletion(
    cohortCourseIds: string[],
    criterion: any,
    tenantId: string,
    organisationId: string,
    userId: string,
  ): Promise<{
    criterion: any;
    status: boolean;
    totalLessons: number;
    completedLessons: number;
    message: string;
  }> {
    // Get all published lessons for the cohort courses matching the format and sub-format
    const lessons = await this.lessonRepository.find({
      where: {
        courseId: In(cohortCourseIds),
        tenantId,
        organisationId,
        status: LessonStatus.PUBLISHED,
        format: criterion.lessonFormat,
        subFormat: criterion.lessonSubFormat,
        // Note: We need to check if lesson has the specific sub-format in params or media
      } as FindOptionsWhere<Lesson>,
    });

    const totalLessons = lessons.length;

    if (totalLessons === 0) {
      return {
        criterion,
        status: false,
        totalLessons: 0,
        completedLessons: 0,
        message: `No lessons found matching format: ${criterion.lessonFormat}, sub-format: ${criterion.lessonSubFormat}`,
      };
    }

    // Count completed lessons based on lesson configurations
    let completedLessons = 0;

    for (const lesson of lessons) {
      const isCompleted = await this.isLessonCompletedForUser(
        lesson,
        userId,
        tenantId,
        organisationId,
      );

      if (isCompleted) {
        completedLessons++;
      }
    }
    const status = completedLessons >= criterion.completionRule;

    return {
      criterion,
      status,
      totalLessons,
      completedLessons,
      message: status
        ? `Criterion met: ${completedLessons}/${totalLessons} lessons completed (required: ${criterion.completionRule})`
        : `Criterion not met: ${completedLessons}/${totalLessons} lessons completed (required: ${criterion.completionRule})`,
    };
  }

  /**
   * Determine if a lesson is completed for a user based on lesson configurations
   */
  private async isLessonCompletedForUser(
    lesson: Lesson,
    userId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<boolean> {
    // Special handling for event format: always check status is completed
    if (lesson.format === 'event') {
      // For event format, find any attempt and check if status is completed
      const eventAttempt = await this.findLessonAttempt({
        lessonId: lesson.lessonId,
        userId,
        tenantId,
        organisationId,
        attempt: 1,
      });

      if (eventAttempt) {
        const isCompleted = eventAttempt.status === TrackingStatus.COMPLETED;

        return isCompleted;
      }

      return false;
    }

    // Handle resubmission logic for non-event formats
    if (lesson.allowResubmission) {
      // If resubmission is enabled, only one attempt should be considered
      // Query for the single attempt (attempt = 1)
      const singleAttempt = await this.findLessonAttempt({
        lessonId: lesson.lessonId,
        userId,
        tenantId,
        organisationId,
        attempt: 1,
      });

      if (!singleAttempt) {
        return false; // No completed attempt
      }
      return true;
    } else {
      // If resubmission is disabled, query for specific attempt based on grading method
      return this.querySpecificAttemptBasedOnGradingMethod(
        lesson,
        userId,
        tenantId,
        organisationId,
      );
    }
  }

  /**
   * Query for specific attempt based on grading method
   */
  private async querySpecificAttemptBasedOnGradingMethod(
    lesson: Lesson,
    userId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<boolean> {
    switch (lesson.attemptsGrade) {
      case AttemptsGradeMethod.FIRST_ATTEMPT:
        // Query for the first attempt only
        const firstAttempt = await this.findLessonAttempt({
          lessonId: lesson.lessonId,
          userId,
          tenantId,
          organisationId,
          attempt: 1,
        });

        if (!firstAttempt) {
          return false;
        }

        return this.evaluateAttemptCompletion(firstAttempt, lesson);

      case AttemptsGradeMethod.LAST_ATTEMPT:
        // Query for the last attempt (highest attempt number)
        const lastAttempt = await this.findLessonAttempt({
          lessonId: lesson.lessonId,
          userId,
          tenantId,
          organisationId,
          orderBy: { attempt: 'DESC' },
        });

        if (!lastAttempt) {
          return false;
        }
        return this.evaluateAttemptCompletion(lastAttempt, lesson);

      case AttemptsGradeMethod.HIGHEST:
        // Query for the attempt with highest score
        const highestAttempt = await this.findLessonAttempt({
          lessonId: lesson.lessonId,
          userId,
          tenantId,
          organisationId,
          orderBy: { score: 'DESC' },
        });

        if (!highestAttempt) {
          return false;
        }

        return this.evaluateAttemptCompletion(highestAttempt, lesson);

      case AttemptsGradeMethod.AVERAGE:
        // For average, we need all attempts to calculate average
        const allAttempts = await this.findAllLessonAttempts({
          lessonId: lesson.lessonId,
          userId,
          tenantId,
          organisationId,
        });

        if (allAttempts.length === 0) {
          return false;
        }

        // Calculate average score
        const totalScore = allAttempts.reduce(
          (sum, attempt) => sum + (attempt.score || 0),
          0,
        );
        const averageScore = totalScore / allAttempts.length;

        // Check if average meets passing criteria
        if (lesson.passingMarks && lesson.totalMarks) {
          const passingPercentage =
            (lesson.passingMarks / lesson.totalMarks) * 100;
          const averagePercentage = (averageScore / lesson.totalMarks) * 100;
          return averagePercentage >= passingPercentage;
        }

        // If no passing criteria, any completed attempt counts
        return true;

      default:
        // Default to last attempt
        const defaultAttempt = await this.findLessonAttempt({
          lessonId: lesson.lessonId,
          userId,
          tenantId,
          organisationId,
          orderBy: { attempt: 'DESC' },
        });

        if (!defaultAttempt) {
          return false;
        }

        return this.evaluateAttemptCompletion(defaultAttempt, lesson);
    }
  }

  /**
   * Evaluate if a single attempt meets completion criteria
   */
  private evaluateAttemptCompletion(
    attempt: LessonTrack,
    lesson: Lesson,
  ): boolean {
    // If no passing criteria, consider completed if status is completed
    return attempt.status === TrackingStatus.COMPLETED;
  }

  /**
   * Reusable method to find a single lesson attempt
   */
  private async findLessonAttempt(params: {
    lessonId: string;
    userId: string;
    tenantId: string;
    organisationId: string;
    attempt?: number;
    orderBy?: { [key: string]: 'ASC' | 'DESC' };
  }): Promise<LessonTrack | null> {
    const whereClause: any = {
      lessonId: params.lessonId,
      userId: params.userId,
      tenantId: params.tenantId,
      organisationId: params.organisationId,
    };

    // Add attempt filter if specified
    if (params.attempt !== undefined) {
      whereClause.attempt = params.attempt;
    }

    const queryOptions: any = {
      where: whereClause as FindOptionsWhere<LessonTrack>,
    };

    // Add ordering if specified
    if (params.orderBy) {
      queryOptions.order = params.orderBy;
    }

    return this.lessonTrackRepository.findOne(queryOptions);
  }

  /**
   * Reusable method to find all lesson attempts
   */
  private async findAllLessonAttempts(params: {
    lessonId: string;
    userId: string;
    tenantId: string;
    organisationId: string;
  }): Promise<LessonTrack[]> {
    return this.lessonTrackRepository.find({
      where: {
        lessonId: params.lessonId,
        userId: params.userId,
        tenantId: params.tenantId,
        organisationId: params.organisationId,
        status: TrackingStatus.COMPLETED,
      } as FindOptionsWhere<LessonTrack>,
    });
  }

  /**
   * Get the correct field name for sorting
   */
  private getSortField(sortBy: string, isCourseLevel: boolean = true): string {
    if (isCourseLevel) {
      switch (sortBy) {
        case 'progress':
          return 'courseTrack.completedLessons';
        case 'lastAccessedDate':
          return 'courseTrack.lastAccessedDate';
        default:
          return 'courseTrack.completedLessons';
      }
    } else {
      switch (sortBy) {
        case 'progress':
          return 'lessonTrack.completionPercentage';
        case 'timeSpent':
          return 'lessonTrack.timeSpent';
        default:
          return 'lessonTrack.completionPercentage';
      }
    }
  }

  /**
   * Update test progress for a lesson based on testId
   */
  async updateTestProgress(
    updateTestProgressDto: UpdateTestProgressDto,
    tenantId: string,
    organisationId: string,
  ): Promise<LessonTrack> {
    const startTime = Date.now();
    this.logger.log(
      `Updating test progress for testId: ${updateTestProgressDto.testId}, userId: ${updateTestProgressDto.userId}`,
    );

    try {
      // Find the media record by testId (stored in source column)
      const media = await this.mediaRepository.findOne({
        where: {
          source: updateTestProgressDto.testId,
          tenantId,
          organisationId,
        },
      });

      if (!media) {
        throw new NotFoundException(
          `Media not found for testId: ${updateTestProgressDto.testId}`,
        );
      }

      // Find the lesson that uses this media
      const lesson = await this.lessonRepository.findOne({
        where: {
          mediaId: media.mediaId,
          tenantId,
          organisationId,
          status: LessonStatus.PUBLISHED,
        },
        relations: ['media'],
      });

      if (!lesson) {
        throw new NotFoundException(
          `Lesson not found for mediaId: ${media.mediaId}`,
        );
      }

      // Determine the correct attempt based on lesson configuration
      let targetAttempt: number;
      let lessonTrack: LessonTrack;

      if (lesson.allowResubmission) {
        // For resubmission allowed lessons, find or create the single attempt
        let existingTrack = await this.lessonTrackRepository.findOne({
          where: {
            lessonId: lesson.lessonId,
            userId: updateTestProgressDto.userId,
            tenantId,
            organisationId,
          },
        });

        if (!existingTrack) {
          // Create new attempt if none exists
          throw new NotFoundException(
            `No lesson tracking found for TestId: ${updateTestProgressDto.testId} and userId: ${updateTestProgressDto.userId}`,
          );
        } else {
          lessonTrack = existingTrack;
        }
        targetAttempt = lessonTrack.attempt;
      } else {
        // For non-resubmission lessons, find the latest attempt
        const latestAttempt = await this.lessonTrackRepository.findOne({
          where: {
            lessonId: lesson.lessonId,
            userId: updateTestProgressDto.userId,
            tenantId,
            organisationId,
          },
          order: {
            attempt: 'DESC',
          },
        });

        if (!latestAttempt) {
          throw new NotFoundException(
            `No lesson tracking found for lessonId: ${lesson.lessonId} and userId: ${updateTestProgressDto.userId}`,
          );
        }

        lessonTrack = latestAttempt;
        targetAttempt = latestAttempt.attempt;
      }

      // Update the lesson track with test results
      // Determine status based on result: COMPLETED for PASS, SUBMITTED for FAIL
      // This ensures that when marks are updated and result changes from PASS to FAIL,
      // the status correctly changes from COMPLETED to SUBMITTED
      // Result can be 'P'/'p' (PASS) or 'F'/'f' (FAIL) from assessment service
      const resultLower = updateTestProgressDto.result?.toLowerCase();
      const status =
        resultLower === 'pass' || resultLower === 'p'
          ? TrackingStatus.COMPLETED
          : TrackingStatus.SUBMITTED;

      const updateData: Partial<LessonTrack> = {
        score: updateTestProgressDto.score,
        status: status,
        updatedBy: updateTestProgressDto.reviewedBy,
        updatedAt: new Date(),
        completionPercentage: 100,
      };
      // Update the lesson track
      Object.assign(lessonTrack, updateData);
      const updatedLessonTrack =
        await this.lessonTrackRepository.save(lessonTrack);

      // Update course and module tracking if lesson is completed
      if (updatedLessonTrack.courseId) {
        await this.trackingService.updateCourseAndModuleTracking(
          updatedLessonTrack,
          tenantId,
          organisationId,
        );
      }

      return updatedLessonTrack;
    } catch (error) {
      this.logger.error(
        `Error updating test progress: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
  async getAggregatedContent(
    cohortId: string | undefined,
    tenantId: string | undefined,
    organisationId: string | undefined,
    authorization: string,
    contentType: string | undefined,
    pathwayId?: string | undefined,
    userId?: string | undefined,
  ): Promise<any> {
    if (cohortId && pathwayId) {
      throw new BadRequestException(
        'Either cohortId or pathwayId must be provided, but not both.',
      );
    }

    const effectiveTenantId =
      tenantId || this.configService.get('TENANT_ID');
    const effectiveOrganisationId =
      organisationId || this.configService.get('ORGANISATION_ID');

    const isFiltered = contentType && contentType !== 'all';

    // Cache key: static structure is cached per pathway/cohort + tenant + org + contentType; tracking is never cached
    const aggregateIdentifier = pathwayId || cohortId;
    const cacheKey = `course:aggregate:${aggregateIdentifier}:${effectiveTenantId}:${effectiveOrganisationId}:${contentType ?? 'all'}`;
    this.logger.log(`[aggregate-content] API called, checking cache key: ${cacheKey}`);
    const cachedStatic = await this.cacheService.getAggregateContentCached(cacheKey);
    if (cachedStatic !== null) {
      this.logger.log(`[aggregate-content] API serving from CACHE (HIT), key: ${cacheKey}`);
      const { courseIds, moduleIds, lessonIds } = this.collectAggregateIds(cachedStatic.courses);
      const trackWhereBase = {
        tenantId: effectiveTenantId,
        organisationId: effectiveOrganisationId,
        ...(userId && { userId }),
      };
      const [courseTracks, moduleTracks, lessonTracks] = await Promise.all([
        courseIds.length
          ? this.courseTrackRepository.find({
              where: {
                courseId: In(courseIds),
                ...trackWhereBase,
              },
            })
          : [],
        moduleIds.length
          ? this.courseRepository.manager.find('module_track', {
              where: {
                moduleId: In(moduleIds),
                ...trackWhereBase,
              },
            })
          : [],
        lessonIds.length && trackWhereBase.userId
          ? this.getGradedLessonTracks(lessonIds, trackWhereBase.userId, effectiveTenantId as string, effectiveOrganisationId as string)
          : [],
      ]);
      const { courseTrackMap, moduleTrackMap, lessonTrackMap } = this.buildTrackingMaps(
        courseTracks,
        moduleTracks,
        lessonTracks,
      );
      const mergedCourses = this.mergeTrackingIntoAggregate(
        JSON.parse(JSON.stringify(cachedStatic.courses)),
        courseTrackMap,
        moduleTrackMap,
        lessonTrackMap,
      );
      return { courses: mergedCourses };
    }

    this.logger.log(`[aggregate-content] API building from DB (CACHE MISS), key: ${cacheKey}`);
    // 1. Find all published courses for the cohort or pathway
    const queryBuilder = this.courseRepository
      .createQueryBuilder('course')
      // Fetch additional fields: shortDescription, description, image
      .select([
        'course.courseId',
        'course.title',
        'course.shortDescription',
        'course.description',
        'course.image',
        'course.params'
      ])
      .where('course."status" = :status', { status: CourseStatus.PUBLISHED });

    if (cohortId) {
      queryBuilder.andWhere(`course."params"->>'cohortId' = :cohortId`, {
        cohortId,
      });
    }

    if (pathwayId) {
      queryBuilder.andWhere(`course."params"->>'pathwayId' = :pathwayId`, {
        pathwayId,
      });
    }

    if (effectiveTenantId) {
      queryBuilder.andWhere('course."tenantId" = :tenantId', {
        tenantId: effectiveTenantId,
      });
    }

    if (effectiveOrganisationId) {
      queryBuilder.andWhere('course."organisationId" = :organisationId', {
        organisationId: effectiveOrganisationId,
      });
    }


const courses = await queryBuilder.getMany();

    if (courses.length === 0) {
      const identifierType = cohortId ? 'cohortId' : 'pathwayId';
      const identifierValue = cohortId || pathwayId;
      throw new NotFoundException(
        `No course found with ${identifierType}: ${identifierValue}`,
      );
    }

    const aggregatedData: any[] = [];
    const courseIds = courses.map((course) => course.courseId);

    // 2. Fetch all modules for these courses
    const moduleWhere: any = {
      courseId: In(courseIds),
      status: Not(CourseStatus.ARCHIVED as any),
    };

    if (effectiveTenantId) moduleWhere.tenantId = effectiveTenantId;
    if (effectiveOrganisationId)
      moduleWhere.organisationId = effectiveOrganisationId;

    const allModules = await this.moduleRepository.find({
      where: moduleWhere,
      // Fetch additional fields: description, image
      select: ['moduleId', 'title', 'courseId', 'parentId', 'description', 'image'],
      order: { ordering: 'ASC' },
    });

    // 3. Fetch all lessons for these courses
    const lessonWhere: any = {
      courseId: In(courseIds),
      status: LessonStatus.PUBLISHED,
    };

    if (effectiveTenantId) lessonWhere.tenantId = effectiveTenantId;
    if (effectiveOrganisationId)
      lessonWhere.organisationId = effectiveOrganisationId;

    if (isFiltered) {
      lessonWhere.format = contentType;
    }

    const allLessons = await this.lessonRepository.find({
      where: lessonWhere,
      select: {
        lessonId: true,
        title: true,
        format: true,
        subFormat: true,
        courseId: true,
        moduleId: true,
        parentId: true,
        // Additional fields
        description: true,
        image: true,
        startDatetime: true,
        endDatetime: true,
        resume: true,
        ordering: true,
        checkedOut: true,
        attemptsGrade: true,
        totalMarks: true,
        passingMarks: true,
        media: {
          mediaId: true,
          format: true,
          subFormat: true,
          path: true,
          source: true,
          status: true,
        },
        associatedFiles: {
            associatedFilesId: true,
            lessonId: true,
            mediaId: true,
            media: {
              mediaId: true,
              format: true,
              subFormat: true,
              path: true,
              source: true
            }
        }
      },
      relations: ['media', 'associatedFiles', 'associatedFiles.media'],
      order: { ordering: 'ASC' },
    });


    // 4. Fetch Tracking Data (filter by userId when provided for correct user-specific progress)
    const trackWhereBase = {
      tenantId: effectiveTenantId,
      organisationId: effectiveOrganisationId,
      ...(userId && { userId }),
    };
    const [courseTracks, moduleTracks, lessonTracks] = await Promise.all([
      this.courseTrackRepository.find({
        where: { courseId: In(courseIds), ...trackWhereBase },
      }),
      this.courseRepository.manager.find('module_track', {
        where: {
          moduleId: In(allModules.map((m) => m.moduleId)),
          ...trackWhereBase,
        },
      }),
      (allLessons.length && trackWhereBase.userId)
        ? this.getGradedLessonTracks(allLessons, trackWhereBase.userId, effectiveTenantId as string, effectiveOrganisationId as string)
        : [],
    ]);

    const { courseTrackMap, moduleTrackMap, lessonTrackMap } = this.buildTrackingMaps(
      courseTracks,
      moduleTracks,
      lessonTracks,
    );

    // 5. Organize data into Maps for O(1) lookup
    const modulesByCourse = new Map<string, CourseModule[]>();
    const submodulesByParent = new Map<string, CourseModule[]>();
    const lessonsByModule = new Map<string, Lesson[]>();
    const nestedLessonsByParent = new Map<string, Lesson[]>();

    allModules.forEach((mod) => {
      if (mod.parentId) {
        if (!submodulesByParent.has(mod.parentId)) submodulesByParent.set(mod.parentId, []);
        submodulesByParent.get(mod.parentId)?.push(mod);
      } else {
        if (!modulesByCourse.has(mod.courseId)) modulesByCourse.set(mod.courseId, []);
        modulesByCourse.get(mod.courseId)?.push(mod);
      }
    });

    allLessons.forEach((lesson) => {
      if (lesson.parentId) {
          if (!nestedLessonsByParent.has(lesson.parentId)) nestedLessonsByParent.set(lesson.parentId, []);
          nestedLessonsByParent.get(lesson.parentId)?.push(lesson);
      } else if (lesson.moduleId) {
        if (!lessonsByModule.has(lesson.moduleId)) lessonsByModule.set(lesson.moduleId, []);
        lessonsByModule.get(lesson.moduleId)?.push(lesson);
      }
    });

    // 6. Build the hierarchical structure in memory
    const coursesList: any[] = [];
    for (const course of courses) {
      const cTrack = courseTrackMap.get(course.courseId);
      const courseData: any = {
        courseId: course.courseId,
        title: course.title,
        shortDescription: course.shortDescription,
        description: course.description,
        image: course.image,
        tracking: {
            status: cTrack?.status || 'incomplete',
            progress: cTrack ? Math.round((cTrack.completedLessons / (cTrack.noOfLessons || 1)) * 100) : 0, // Approx if not stored
            completedLessons: cTrack?.completedLessons || 0,
            totalLessons: cTrack?.noOfLessons || 0,
        },
        modules: [],
      };

      const topModules = modulesByCourse.get(course.courseId) || [];

      for (const module of topModules) {
        const mTrack = moduleTrackMap.get(module.moduleId);
        const moduleData: any = {
          moduleId: module.moduleId,
          courseId: module.courseId,
          title: module.title,
          description: module.description,
          image: module.image,
          tracking: {
              status: mTrack?.['status'] || 'incomplete',
              progress: mTrack?.['progress'] || 0,
              completedLessons: mTrack?.['completedLessons'] || 0,
              totalLessons: mTrack?.['totalLessons'] || 0
          },
          contents: [],
        };

        const submodules = submodulesByParent.get(module.moduleId) || [];
        const directLessons = lessonsByModule.get(module.moduleId) || [];

        // Collect all lessons for this "Lesson" (renamed from Module/SubModule context in typical LMS terms)
        const allModuleLessons = [...directLessons];

        // Flatten sub-modules into the contents of the unit
        for (const submodule of submodules) {
          const submoduleLessons = lessonsByModule.get(submodule.moduleId) || [];
          allModuleLessons.push(...submoduleLessons);
        }

        moduleData.contents = allModuleLessons.map((lesson) => {
            const lTrack = lessonTrackMap.get(lesson.lessonId);
            const nested = nestedLessonsByParent.get(lesson.lessonId) || [];
            
            return {
                lessonId: lesson.lessonId,
                title: lesson.title,
                description: lesson.description,
                image: lesson.image,
                startDateTime: lesson.startDatetime,
                endDateTime: lesson.endDatetime,
                format: lesson.format,
                subFormat: lesson.subFormat,
                resume: lesson.resume,
                ordering: lesson.ordering,
                media: lesson.media ? {
                    mediaId: lesson.media.mediaId,
                    format: lesson.media.format,
                    subFormat: lesson.media.subFormat,
                    path: lesson.media.path,
                    source: lesson.media.source,
                    // status: lesson.media.status // Removed based on prompt requirement not strictly showing this in media obj
                } : null,
                associatedFiles: lesson.associatedFiles?.map(af => ({
                    lessonID: af.lessonId,
                    mediaId: af.mediaId,
                    media: af.media ? {
                        mediaId: af.media.mediaId,
                        format: af.media.format,
                        subFormat: af.media.subFormat,
                        path: af.media.path,
                        source: af.media.source
                    } : null
                })) || [],
                associatedLesson: nested.map(nl => {
                    const nlTrack = lessonTrackMap.get(nl.lessonId);
                    return {
                        lessonId: nl.lessonId,
                        title: nl.title,
                        desc: nl.description,
                        image: nl.image,
                        startDateTime: nl.startDatetime,
                        endDateTime: nl.endDatetime,
                        format: nl.format,
                        subformat: nl.subFormat,
                        resume: nl.resume,
                        media: nl.media ? {
                            mediaId: nl.media.mediaId,
                            path: nl.media.path,
                            source: nl.media.source
                        } : null,
                        associatedFiles: nl.associatedFiles?.map(af => ({
                            lessonID: af.lessonId,
                            mediaId: af.mediaId,
                            media: af.media
                        })) || [],
                        tracking: {
                            status: nlTrack?.status || 'not_started',
                            progress: nlTrack?.completionPercentage || 0,
                            lastAccessed: nlTrack?.startDatetime, // approximate
                            timeSpent: nlTrack?.timeSpent || 0,
                            score: nlTrack?.score,
                            attempt: nlTrack?.attempt
                        }
                    };
                }),
                tracking: {
                    status: lTrack?.status || 'not_started',
                    progress: lTrack?.completionPercentage || 0,
                    lastAccessed: lTrack?.startDatetime,
                    timeSpent: lTrack?.timeSpent || 0,
                    score: lTrack?.score,
                    attempt: lTrack?.attempt
                }
            };
        });

        if (moduleData.contents.length > 0 || !isFiltered) {
          courseData.modules.push(moduleData);
        }
      }

      if (courseData.modules.length > 0 || !isFiltered) {
        coursesList.push(courseData);
      }
    }

    if (coursesList.length === 0 && isFiltered) {
      return {
        courses: [],
      };
    }

    // Cache static structure only (no tracking); tracking is merged on each request when served from cache
    const staticCopy = this.stripTrackingFromAggregate(coursesList);
    this.logger.log(`[aggregate-content] API caching response for next request, key: ${cacheKey}`);
    await this.cacheService.setAggregateContentCached(cacheKey, { courses: staticCopy });

    return {
      courses: coursesList,
    };
  }

  /**
   * Helper method to get the "best" or "specified" attempt per lesson for a user based on attemptsGrade configuration.
   */
  private async getGradedLessonTracks(lessons: any[], userId: string, tenantId: string, organisationId: string): Promise<any[]> {
    if (!lessons || lessons.length === 0) return [];

    let lessonRules = lessons;
    // If we only have IDs, or missing required fields (like in CACHE HIT scenario with old cache), fetch them
    if (typeof lessons[0] === 'string' || !lessons[0].attemptsGrade) {
      const ids = typeof lessons[0] === 'string' ? lessons : lessons.map(l => l.lessonId);
      lessonRules = await this.lessonRepository.find({
        where: { lessonId: In(ids), tenantId, organisationId },
        select: ['lessonId', 'attemptsGrade', 'totalMarks', 'passingMarks']
      });
    }

    const lessonIds = lessonRules.map(l => l.lessonId);
    // Fetch all attempts for these lessons and user, sorted by attempt number
    const allTracks = await this.lessonTrackRepository.find({
      where: {
        lessonId: In(lessonIds),
        userId,
        tenantId,
        organisationId,
      },
      order: {
        attempt: 'ASC',
      },
    });

    // Group attempts by lessonId
    const tracksByLesson = new Map<string, any[]>();
    allTracks.forEach(track => {
      if (!tracksByLesson.has(track.lessonId)) {
        tracksByLesson.set(track.lessonId, []);
      }
      tracksByLesson.get(track.lessonId)?.push(track);
    });

    const bestTracks: any[] = [];
    for (const lesson of lessonRules) {
      const attempts = tracksByLesson.get(lesson.lessonId) || [];
      if (attempts.length === 0) continue;

      let selectedAttempt: any = null;
      const gradeMethod = lesson.attemptsGrade || AttemptsGradeMethod.LAST_ATTEMPT;

      switch (gradeMethod) {
        case AttemptsGradeMethod.FIRST_ATTEMPT:
          selectedAttempt = attempts.find(a => a.attempt === 1);
          break;

        case AttemptsGradeMethod.HIGHEST:
          // Find the attempt with the highest score
          selectedAttempt = attempts.reduce((prev, current) => {
            return (prev.score > current.score) ? prev : current;
          }, attempts[0]);
          break;

        case AttemptsGradeMethod.AVERAGE: {
          // Calculate average score across all attempts
          const totalScore = attempts.reduce((sum, a) => sum + (a.score || 0), 0);
          const averageScore = totalScore / attempts.length;
          // Use the latest attempt as the base structure but update the score to the average
          const latestForAvg = attempts.at(-1);
          selectedAttempt = { 
            ...latestForAvg, 
            score: Math.round(averageScore * 100) / 100 // Round to 2 decimal places
          };
          break;
        }

        case AttemptsGradeMethod.LAST_ATTEMPT:
        default: {
          // Pick the last COMPLETED attempt if it exists
          selectedAttempt = [...attempts].reverse().find(a => a.status === TrackingStatus.COMPLETED);
          
          // Fallback to the absolute latest attempt if no completed attempt is found
          if (!selectedAttempt) {
            selectedAttempt = attempts.at(-1);
          }
          break;
        }
      }

      if (selectedAttempt) {
        bestTracks.push(selectedAttempt);
      }
    }

    return bestTracks;
  }

  /**
   * Build Maps for O(1) tracking lookup by courseId, moduleId, lessonId
   */
  private buildTrackingMaps(
    courseTracks: any[],
    moduleTracks: any[],
    lessonTracks: any[],
  ): {
    courseTrackMap: Map<string, any>;
    moduleTrackMap: Map<string, any>;
    lessonTrackMap: Map<string, any>;
  } {
    return {
      courseTrackMap: new Map<string, any>(
        courseTracks.map((t: any) => [t.courseId, t] as [string, any]),
      ),
      moduleTrackMap: new Map<string, any>(
        moduleTracks.map((t: any) => [t['moduleId'], t] as [string, any]),
      ),
      lessonTrackMap: new Map<string, any>(
        lessonTracks.map((t: any) => [t.lessonId, t] as [string, any]),
      ),
    };
  }

  /**
   * Collect courseIds, moduleIds, lessonIds from aggregated courses tree (for fetching tracking after cache hit)
   */
  private collectAggregateIds(courses: any[]): { courseIds: string[]; moduleIds: string[]; lessonIds: string[] } {
    const courseIds: string[] = [];
    const moduleIds: string[] = [];
    const lessonIds: string[] = [];
    for (const c of courses) {
      if (c.courseId) courseIds.push(c.courseId);
      for (const m of c.modules || []) {
        if (m.moduleId) moduleIds.push(m.moduleId);
        for (const cnt of m.contents || []) {
          if (cnt.lessonId) lessonIds.push(cnt.lessonId);
          for (const al of cnt.associatedLesson || []) {
            if (al.lessonId) lessonIds.push(al.lessonId);
          }
        }
      }
    }
    return { courseIds, moduleIds, lessonIds };
  }

  /**
   * Deep clone aggregated courses and remove every 'tracking' key (for caching static structure only)
   */
  private stripTrackingFromAggregate(courses: any[]): any[] {
    return courses.map((c) => {
      const { tracking: _tc, modules: mods, ...courseRest } = c;
      return {
        ...courseRest,
        modules: (mods || []).map((m: any) => {
          const { tracking: _tm, contents: conts, ...moduleRest } = m;
          return {
            ...moduleRest,
            contents: (conts || []).map((cnt: any) => {
              const { tracking: _tl, associatedLesson: assoc, ...contentRest } = cnt;
              return {
                ...contentRest,
                associatedLesson: (assoc || []).map((al: any) => {
                  const { tracking: _ta, ...alRest } = al;
                  return alRest;
                }),
              };
            }),
          };
        }),
      };
    });
  }

  /**
   * Add tracking data into a copy of static aggregated courses (used when serving from cache).
   * Builds new objects with property order matching DB response: tracking before modules, tracking before contents.
   */
  private mergeTrackingIntoAggregate(
    courses: any[],
    courseTrackMap: Map<string, any>,
    moduleTrackMap: Map<string, any>,
    lessonTrackMap: Map<string, any>,
  ): any[] {
    return courses.map((course) => {
      const cTrack = courseTrackMap.get(course.courseId);
      const tracking = {
        status: cTrack?.status || 'incomplete',
        progress: cTrack ? Math.round((cTrack.completedLessons / (cTrack.noOfLessons || 1)) * 100) : 0,
        completedLessons: cTrack?.completedLessons || 0,
        totalLessons: cTrack?.noOfLessons || 0,
      };
      const modules = (course.modules || []).map((m: any) => {
        const mTrack = moduleTrackMap.get(m.moduleId);
        const moduleTracking = {
          status: mTrack?.['status'] || 'incomplete',
          progress: mTrack?.['progress'] || 0,
          completedLessons: mTrack?.['completedLessons'] || 0,
          totalLessons: mTrack?.['totalLessons'] || 0,
        };
        const contents = (m.contents || []).map((cnt: any) => {
          const lTrack = lessonTrackMap.get(cnt.lessonId);
          const contentTracking = {
            status: lTrack?.status || 'not_started',
            progress: lTrack?.completionPercentage || 0,
            lastAccessed: lTrack?.startDatetime,
            timeSpent: lTrack?.timeSpent || 0,
            score: lTrack?.score,
            attempt: lTrack?.attempt,
          };
          const associatedLesson = (cnt.associatedLesson || []).map((al: any) => {
            const nlTrack = lessonTrackMap.get(al.lessonId);
            const alTracking = {
              status: nlTrack?.status || 'not_started',
              progress: nlTrack?.completionPercentage || 0,
              lastAccessed: nlTrack?.startDatetime,
              timeSpent: nlTrack?.timeSpent || 0,
              score: nlTrack?.score,
              attempt: nlTrack?.attempt,
            };
            return { ...al, tracking: alTracking };
          });
          return { ...cnt, associatedLesson, tracking: contentTracking };
        });
        // Explicit order: ...moduleFields, tracking, contents (tracking before contents)
        const { contents: _c, ...moduleRest } = m;
        return { ...moduleRest, tracking: moduleTracking, contents };
      });
      // Explicit order: ...courseFields, tracking, modules (tracking before modules)
      const { modules: _m, ...courseRest } = course;
      return { ...courseRest, tracking, modules };
    });
  }
}
