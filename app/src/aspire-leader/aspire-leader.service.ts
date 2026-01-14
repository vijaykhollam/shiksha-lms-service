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
import { TrackingService } from 'src/tracking/tracking.service';

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
    private readonly configService: ConfigService,
  ) {}

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
      `Generating course report for courseId: ${reportDto.courseId}, cohortId: ${reportDto.cohortId}`,
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
}
