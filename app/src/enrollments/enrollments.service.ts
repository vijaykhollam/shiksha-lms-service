import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  Not,
  FindOptionsWhere,
  DataSource,
  In,
} from 'typeorm';
import {
  UserEnrollment,
  EnrollmentStatus,
} from './entities/user-enrollment.entity';
import { Course } from '../courses/entities/course.entity';
import { CourseStatus } from '../courses/entities/course.entity';
import { CourseTrack } from '../tracking/entities/course-track.entity';
import { TrackingStatus } from '../tracking/entities/course-track.entity';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { RESPONSE_MESSAGES } from '../common/constants/response-messages.constant';
import { CacheService } from '../cache/cache.service';
import { ConfigService } from '@nestjs/config';
import { Lesson, LessonStatus } from '../lessons/entities/lesson.entity';
import {
  Module as CourseModule,
  ModuleStatus,
} from '../modules/entities/module.entity';
import {
  ModuleTrack,
  ModuleTrackStatus,
} from '../tracking/entities/module-track.entity';
import { LessonTrack } from '../tracking/entities/lesson-track.entity';
import { InjectDataSource } from '@nestjs/typeorm';
import { CacheConfigService } from '../cache/cache-config.service';
import {
  UsersEnrolledCoursesDto,
  UsersEnrolledCoursesResponseDto,
} from './dto/search-enrolled-courses.dto';

@Injectable()
export class EnrollmentsService {
  private readonly logger = new Logger(EnrollmentsService.name);

  constructor(
    @InjectRepository(UserEnrollment)
    private readonly userEnrollmentRepository: Repository<UserEnrollment>,
    @InjectRepository(Course)
    private readonly courseRepository: Repository<Course>,
    @InjectRepository(CourseTrack)
    private readonly courseTrackRepository: Repository<CourseTrack>,
    @InjectRepository(CourseModule)
    private readonly moduleRepository: Repository<CourseModule>,
    @InjectRepository(ModuleTrack)
    private readonly moduleTrackRepository: Repository<ModuleTrack>,
    @InjectRepository(LessonTrack)
    private readonly lessonTrackRepository: Repository<LessonTrack>,
    private readonly cacheService: CacheService,
    private readonly configService: ConfigService,
    @InjectRepository(Lesson)
    private readonly lessonRepository: Repository<Lesson>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly cacheConfig: CacheConfigService,
  ) {}

  /**
   * Enroll a user for a course
   * @param createEnrollmentDto The enrollment data
   * @param organisationId The organization ID for data isolation
   */
  async enroll(
    createEnrollmentDto: CreateEnrollmentDto,
    userId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<UserEnrollment> {
    this.logger.log(`Enrolling user: ${JSON.stringify(createEnrollmentDto)}`);

    // Create a query runner for transaction
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      const { courseId } = createEnrollmentDto;

      // Build where clause for course validation with data isolation
      const courseWhereClause: FindOptionsWhere<Course> = {
        courseId,
        tenantId,
        status: Not(CourseStatus.ARCHIVED),
        organisationId,
      };

      // Validate course exists with proper data isolation
      const course = await queryRunner.manager.findOne(Course, {
        where: courseWhereClause,
      });

      if (!course) {
        throw new NotFoundException(RESPONSE_MESSAGES.COURSE_NOT_FOUND);
      }

      // Check if admin approval is required
      if (course.adminApproval) {
        createEnrollmentDto.status = EnrollmentStatus.UNPUBLISHED;
      }

      // Build where clause for existing enrollment check with data isolation
      const enrollmentWhereClause: FindOptionsWhere<UserEnrollment> = {
        courseId,
        userId: createEnrollmentDto.learnerId,
        tenantId,
        organisationId,
      };

      // Check for existing active enrollment
      const existingEnrollment = await queryRunner.manager.findOne(
        UserEnrollment,
        {
          where: enrollmentWhereClause,
        },
      );

      if (existingEnrollment) {
        throw new ConflictException(RESPONSE_MESSAGES.ALREADY_ENROLLED);
      }

      // Calculate end time based on course settings
      let endTime: Date | null = null;
      if (course.endDatetime) {
        endTime = new Date(course.endDatetime);
      } else if (createEnrollmentDto.endTime) {
        endTime = new Date(createEnrollmentDto.endTime);
      }

      // Parse JSON params if they are provided as a string
      let params = createEnrollmentDto.params;
      if (typeof params === 'string') {
        try {
          params = JSON.parse(params);
        } catch (error) {
          this.logger.error(`Error parsing params JSON: ${error.message}`);
          throw new BadRequestException(
            RESPONSE_MESSAGES.ERROR.INVALID_PARAMS_FORMAT,
          );
        }
      }

      // Create new enrollment entity
      const enrollment = queryRunner.manager.create(UserEnrollment, {
        courseId,
        userId: createEnrollmentDto.learnerId,
        tenantId,
        organisationId,
        enrolledOnTime: new Date(),
        endTime: endTime || undefined,
        status: createEnrollmentDto.status || EnrollmentStatus.PUBLISHED,
        unlimitedPlan: createEnrollmentDto.unlimitedPlan || false,
        beforeExpiryMail: createEnrollmentDto.beforeExpiryMail || false,
        afterExpiryMail: createEnrollmentDto.afterExpiryMail || false,
        params: params,
        enrolledBy: userId,
        enrolledAt: new Date(),
      });

      // Save the enrollment
      const savedEnrollment = await queryRunner.manager.save(enrollment);

      // Get all published modules for the course
      const modules = await queryRunner.manager.find(CourseModule, {
        where: {
          courseId,
          tenantId,
          organisationId,
          status: ModuleStatus.PUBLISHED,
        },
      });

      // Count total lessons for the course (only published parent lessons in published modules with considerForPassing = true)
      const courseLessons = await queryRunner.manager
        .createQueryBuilder(Lesson, 'lesson')
        .innerJoin('lesson.module', 'module')
        .where('lesson.status = :lessonStatus', {
          lessonStatus: LessonStatus.PUBLISHED,
        })
        .andWhere('module.status = :moduleStatus', {
          moduleStatus: ModuleStatus.PUBLISHED,
        })
        .andWhere('module.courseId = :courseId', { courseId })
        .andWhere('lesson.tenantId = :tenantId', { tenantId })
        .andWhere('lesson.organisationId = :organisationId', { organisationId })
        .andWhere('lesson.considerForPassing = :considerForPassing', {
          considerForPassing: true,
        })
        .andWhere('lesson.parentId IS NULL') // Only count parent lessons, exclude child lessons
        .getCount();

      // Create course tracking record
      const courseTrack = queryRunner.manager.create(CourseTrack, {
        courseId,
        tenantId,
        organisationId,
        userId: createEnrollmentDto.learnerId,
        startDatetime: new Date(),
        noOfLessons: courseLessons,
        completedLessons: 0,
        status: TrackingStatus.STARTED,
        lastAccessedDate: new Date(),
      });

      await queryRunner.manager.save(courseTrack);

      // Create module tracking records for each published module (bulk approach)
      if (modules.length > 0) {
        // Step 1: Preload lesson counts for all modules in a single query
        const moduleIds = modules.map((m) => m.moduleId);

        const lessonCounts = await queryRunner.manager
          .createQueryBuilder(Lesson, 'lesson')
          .select('lesson.moduleId', 'moduleId')
          .addSelect('COUNT(*)', 'count')
          .where('lesson.moduleId IN (:...moduleIds)', { moduleIds })
          .andWhere('lesson.status = :lessonStatus', {
            lessonStatus: LessonStatus.PUBLISHED,
          })
          .andWhere('lesson.tenantId = :tenantId', { tenantId })
          .andWhere('lesson.organisationId = :organisationId', {
            organisationId,
          })
          .andWhere('lesson.considerForPassing = :considerForPassing', {
            considerForPassing: true,
          })
          .andWhere('lesson.parentId IS NULL') // Only count parent lessons, exclude child lessons
          .groupBy('lesson.moduleId')
          .getRawMany();

        // Step 2: Build a map of moduleId to lesson count
        const lessonCountMap = new Map<string, number>();
        lessonCounts.forEach((row) => {
          lessonCountMap.set(row.moduleId, parseInt(row.count, 10));
        });

        // Step 3: Create ModuleTrack records
        const moduleTracks = modules.map((module) => {
          const totalLessons = lessonCountMap.get(module.moduleId) || 0;

          return queryRunner.manager.create(ModuleTrack, {
            moduleId: module.moduleId,
            tenantId,
            organisationId,
            userId: createEnrollmentDto.learnerId,
            status: ModuleTrackStatus.INCOMPLETE,
            completedLessons: 0,
            totalLessons,
            progress: 0,
          });
        });

        // Step 4: Bulk save
        await queryRunner.manager.save(ModuleTrack, moduleTracks);
      }

      // Find and return the complete enrollment with relations
      const completeEnrollment = await queryRunner.manager.findOne(
        UserEnrollment,
        {
          where: { enrollmentId: savedEnrollment.enrollmentId },
          // relations: ['course'],
        },
      );

      if (!completeEnrollment) {
        throw new InternalServerErrorException(
          RESPONSE_MESSAGES.ENROLLMENT_ERROR,
        );
      }

      // Commit the transaction
      await queryRunner.commitTransaction();

      // Cache the new enrollment and invalidate related caches (best-effort, non-blocking)
      // Cache operations are wrapped to prevent Redis errors from breaking requests
      const enrollmentKey = this.cacheConfig.getEnrollmentKey(
        savedEnrollment.userId,
        savedEnrollment.courseId,
        tenantId,
        organisationId,
      );
      try {
        await Promise.all([
          this.cacheService.invalidateEnrollment(
            savedEnrollment.userId,
            savedEnrollment.courseId,
            tenantId,
            organisationId,
          ),
          this.cacheService.set(
            enrollmentKey,
            savedEnrollment,
            this.cacheConfig.ENROLLMENT_TTL,
          ),
        ]);
      } catch (cacheError) {
        // Log cache operation failure but don't break the request
        // Cache is an optimization - API should work even if Redis is down
        this.logger.warn(
          `Failed to cache enrollment: ${cacheError.message}`
        );
      }

      return completeEnrollment;
    } catch (error) {
      // Rollback the transaction on error
      await queryRunner.rollbackTransaction();

      this.logger.error(`Error enrolling user: ${error.message}`);
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      throw new InternalServerErrorException(
        RESPONSE_MESSAGES.ENROLLMENT_ERROR,
      );
    } finally {
      // Release the query runner
      await queryRunner.release();
    }
  }

  /**
   * Find all enrollments with pagination and filters
   */
  async findAll(
    tenantId: string,
    organisationId: string,
    paginationDto: PaginationDto,
    learnerId?: string,
    courseId?: string,
    status?: string,
  ): Promise<{ count: number; enrollments: UserEnrollment[] }> {
    try {
      const { page = 1, limit = 10 } = paginationDto;
      const skip = (page - 1) * limit;

      // Generate cache key using standardized pattern
      const cacheKey = this.cacheConfig.getEnrollmentListKey(
        tenantId,
        organisationId,
        learnerId || '',
        courseId || '',
        status || '',
        page,
        limit,
      );

      // Try to get from cache first
      const cachedResult = await this.cacheService.get<{
        count: number;
        enrollments: UserEnrollment[];
      }>(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }

      const whereConditions: FindOptionsWhere<UserEnrollment> = {
        tenantId,
        organisationId,
      };

      if (learnerId) {
        whereConditions.userId = learnerId;
      }
      if (courseId) {
        whereConditions.courseId = courseId;
      }
      if (status) {
        whereConditions.status = status as EnrollmentStatus;
      }

      // Execute query with pagination
      const [enrollments, count] =
        await this.userEnrollmentRepository.findAndCount({
          where: whereConditions,
          skip,
          take: limit,
          order: {
            enrolledOnTime: 'DESC',
          },
          // relations: ['course'],
        });

      const result = { count, enrollments };

      // Cache the result with standardized TTL (best-effort, non-blocking)
      // Cache writes are wrapped to prevent Redis errors from breaking requests
      try {
        await this.cacheService.set(
          cacheKey,
          result,
          this.cacheConfig.ENROLLMENT_TTL,
        );
      } catch (cacheError) {
        // Log cache write failure but don't break the request
        // Cache is an optimization - API should work even if Redis is down
        this.logger.warn(
          `Failed to cache enrollment list: ${cacheError.message}`
        );
      }

      return result;
    } catch (error) {
      this.logger.error(`Error finding enrollments: ${error.message}`);
      throw new InternalServerErrorException(RESPONSE_MESSAGES.FETCH_ERROR);
    }
  }

  /**
   * Find a single enrollment by ID
   */
  async findOne(
    enrollmentId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<UserEnrollment> {
    try {
      // Check cache using the enrollment's userId and courseId
      const cacheKey = this.cacheConfig.getUserEnrollmentKey(
        enrollmentId,
        tenantId,
        organisationId,
      );
      const cachedEnrollment =
        await this.cacheService.get<UserEnrollment>(cacheKey);

      if (cachedEnrollment) {
        return cachedEnrollment;
      }

      // Get enrollment from database first to get userId and courseId for cache key
      const enrollment = await this.userEnrollmentRepository.findOne({
        where: { enrollmentId, tenantId, organisationId },
        // relations: ['course'],
      });

      if (!enrollment) {
        throw new NotFoundException(RESPONSE_MESSAGES.ENROLLMENT_NOT_FOUND);
      }

      // Cache the enrollment with TTL (best-effort, non-blocking)
      // Cache writes are wrapped to prevent Redis errors from breaking requests
      try {
        await this.cacheService.set(
          cacheKey,
          enrollment,
          this.cacheConfig.ENROLLMENT_TTL,
        );
      } catch (cacheError) {
        // Log cache write failure but don't break the request
        // Cache is an optimization - API should work even if Redis is down
        this.logger.warn(
          `Failed to cache enrollment: ${cacheError.message}`
        );
      }

      return enrollment;
    } catch (error) {
      this.logger.error(`Error finding enrollment: ${error.message}`);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(RESPONSE_MESSAGES.FETCH_ERROR);
    }
  }

  /**
   * Search and filter enrolled courses
   *
   * This method assembles data from:
   * 1. User + cohort enrollment mapping (user-specific, NOT cached - always fetched from DB)
   * 2. Course metadata (shared, cacheable - cached when LMS_CACHE_ENABLED=true)
   *
   * We do NOT cache the full API response because:
   * - Enrollment data is user-specific and must be fresh
   * - Different users may have different enrollments for the same course
   * - Caching full responses would lead to stale or incorrect data
   *
   * We DO cache course metadata because:
   * - Course metadata (title, description, image, status, etc.) is shared across users
   * - Course metadata rarely changes
   * - Caching metadata reduces database load for frequently accessed courses
   */
  async usersEnrolledCourses(
    filters: UsersEnrolledCoursesDto,
    tenantId: string,
    organisationId: string,
  ): Promise<UsersEnrolledCoursesResponseDto> {
    try {
      // Validate and sanitize inputs
      const offset = Math.max(0, filters.offset || 0);
      const limit = Math.min(100, Math.max(1, filters.limit || 10));

      // STEP 1: Always fetch enrollment mapping from DB (user-specific, never cached)
      // This query gets the courseIds that the user is enrolled in
      // Enrollment mapping is always fetched from DB to ensure fresh, user-specific data
      const enrollmentQueryBuilder = this.userEnrollmentRepository
        .createQueryBuilder('enrollment')
        .innerJoin('enrollment.course', 'course')
        .select(['enrollment.courseId', 'enrollment.userId', 'course.courseId'])
        .where('enrollment.tenantId = :tenantId', { tenantId })
        .andWhere('enrollment.organisationId = :organisationId', {
          organisationId,
        })
        .andWhere('enrollment.status = :enrollmentStatus', {
          enrollmentStatus: EnrollmentStatus.PUBLISHED,
        })
        .andWhere('course.status = :coursePublishedStatus', {
          coursePublishedStatus: CourseStatus.PUBLISHED,
        });

      // Apply user filter if provided
      if (filters?.userId) {
        enrollmentQueryBuilder.andWhere('enrollment.userId = :userId', {
          userId: filters.userId,
        });
      }

      // Apply cohort filter if provided (filter by course params)
      if (filters?.cohortId) {
        enrollmentQueryBuilder.andWhere(
          "course.params->>'cohortId' = :cohortId",
          { cohortId: filters.cohortId },
        );
      }

      // Apply pathway filter if provided (filter by course params)
      if (filters?.pathwayId) {
        enrollmentQueryBuilder.andWhere(
          "course.params->>'pathwayId' = :pathwayId",
          { pathwayId: filters.pathwayId },
        );
      }

      // Get enrolled course IDs
      const enrollments = await enrollmentQueryBuilder.getMany();
      const enrolledCourseIds = [
        ...new Set(enrollments.map((e) => e.courseId)),
      ];

      if (enrolledCourseIds.length === 0) {
        return {
          courses: [],
          totalElements: 0,
          offset,
          limit,
        };
      }

      // STEP 2: Fetch course metadata (cacheable when LMS_CACHE_ENABLED=true)
      // For each course, check cache first, then fetch from DB if needed
      const courses: Course[] = [];
      const courseIdsToFetch: string[] = [];

      // Check cache for each course metadata
      for (const courseId of enrolledCourseIds) {
        const cachedMeta = await this.cacheService.getCourseMetaCached(
          courseId,
          filters?.cohortId || filters?.pathwayId,
        );

        if (cachedMeta) {
          // Cache HIT: Use cached metadata
          courses.push(cachedMeta as Course);
        } else {
          // Cache MISS: Mark for DB fetch
          courseIdsToFetch.push(courseId);
        }
      }

      // STEP 3: Fetch course metadata from DB for cache misses
      if (courseIdsToFetch.length > 0) {
        const courseQueryBuilder = this.courseRepository
          .createQueryBuilder('course')
          .select([
            'course.courseId',
            'course.tenantId',
            'course.organisationId',
            'course.title',
            'course.alias',
            'course.shortDescription',
            'course.description',
            'course.image',
            'course.featured',
            'course.free',
            'course.status',
            'course.params',
            'course.ordering',
            'course.createdAt',
            'course.updatedAt',
          ])
          .where('course.courseId IN (:...courseIds)', {
            courseIds: courseIdsToFetch,
          })
          .andWhere('course.tenantId = :tenantId', { tenantId })
          .andWhere('course.organisationId = :organisationId', {
            organisationId,
          })
          .andWhere('course.status = :coursePublishedStatus', {
            coursePublishedStatus: CourseStatus.PUBLISHED,
          });

        // Note: Cohort filter already applied in enrollment query, so courses are pre-filtered

        const fetchedCourses = await courseQueryBuilder.getMany();

        // Cache the fetched course metadata for future requests
        for (const course of fetchedCourses) {
          // Extract only metadata fields for caching (not full entity)
          const courseMeta = {
            courseId: course.courseId,
            tenantId: course.tenantId,
            organisationId: course.organisationId,
            title: course.title,
            alias: course.alias,
            shortDescription: course.shortDescription,
            description: course.description,
            image: course.image,
            featured: course.featured,
            free: course.free,
            status: course.status,
            params: course.params,
            ordering: course.ordering,
            prerequisites: course.prerequisites,
            certificateTerm: course.certificateTerm,
            createdAt: course.createdAt,
            updatedAt: course.updatedAt,
          };

          // Store in cache for future requests (best-effort, non-blocking)
          // Cache writes are wrapped in try-catch to prevent Redis errors from breaking requests
          try {
            await this.cacheService.setCourseMetaCached(
              course.courseId,
              courseMeta,
              filters?.cohortId || filters?.pathwayId,
            );
          } catch (cacheError) {
            // Log cache write failure but don't break the request
            // Cache is an optimization - API should work even if Redis is down
            this.logger.warn(
              `Failed to cache course metadata for courseId ${course.courseId}: ${cacheError.message}`
            );
          }

          courses.push(course);
        }
      }

      // Exclude unpublished/archived if cache metadata is stale
      const publishedOnly = courses.filter(
        (c) => c.status === CourseStatus.PUBLISHED,
      );

      // STEP 4: Apply sorting and pagination
      // Sort by ordering (ascending)
      publishedOnly.sort((a, b) => (a.ordering || 0) - (b.ordering || 0));

      // Apply pagination
      const total = publishedOnly.length;
      const paginatedCourses = publishedOnly.slice(offset, offset + limit);

      // STEP 5: Build response
      // Note: We do NOT cache the full response because it contains user-specific enrollment data
      const result: UsersEnrolledCoursesResponseDto = {
        courses: paginatedCourses,
        totalElements: total,
        offset,
        limit,
      };

      return result;
    } catch (error) {
      this.logger.error(`Error searching enrolled courses: ${error.message}`);
      throw new InternalServerErrorException(RESPONSE_MESSAGES.FETCH_ERROR);
    }
  }

  /**
   * Update an enrollment
   */
  async update(
    enrollmentId: string,
    updateEnrollmentDto: UpdateEnrollmentDto,
    tenantId: string,
    organisationId: string,
  ): Promise<UserEnrollment> {
    try {
      const enrollment = await this.findOne(
        enrollmentId,
        tenantId,
        organisationId,
      );

      // Update enrollment fields
      Object.assign(enrollment, updateEnrollmentDto);

      // Save updated enrollment
      const updatedEnrollment =
        await this.userEnrollmentRepository.save(enrollment);

      // Update cache and invalidate related caches (best-effort, non-blocking)
      // Cache operations are wrapped to prevent Redis errors from breaking requests
      const enrollmentKey = this.cacheConfig.getEnrollmentKey(
        updatedEnrollment.userId,
        updatedEnrollment.courseId,
        tenantId,
        organisationId,
      );
      try {
        await Promise.all([
          this.cacheService.invalidateEnrollment(
            updatedEnrollment.userId,
            updatedEnrollment.courseId,
            tenantId,
            organisationId,
          ),
          this.cacheService.del(
            this.cacheConfig.getUserEnrollmentKey(
              enrollmentId,
              tenantId,
              organisationId,
            ),
          ),
          this.cacheService.set(
            enrollmentKey,
            updatedEnrollment,
            this.cacheConfig.ENROLLMENT_TTL,
          ),
        ]);
      } catch (cacheError) {
        // Log cache operation failure but don't break the request
        // Cache is an optimization - API should work even if Redis is down
        this.logger.warn(
          `Failed to update enrollment cache: ${cacheError.message}`
        );
      }

      return updatedEnrollment;
    } catch (error) {
      this.logger.error(`Error updating enrollment: ${error.message}`);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(RESPONSE_MESSAGES.UPDATE_ERROR);
    }
  }

  /**
   * Hard delete enrollment and all related tracking records
   */
  async hardDelete(
    courseId: string,
    userId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<{ success: boolean; message: string }> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      // Find the enrollment
      const enrollment = await queryRunner.manager.findOne(UserEnrollment, {
        where: {
          courseId,
          userId,
          tenantId,
          organisationId,
        },
      });

      if (!enrollment) {
        throw new NotFoundException(RESPONSE_MESSAGES.ENROLLMENT_NOT_FOUND);
      }

      // Check if user has any lesson attempts for this course
      const lessonAttempts = await queryRunner.manager.find(LessonTrack, {
        where: {
          courseId,
          userId,
          tenantId,
          organisationId,
        },
        select: ['lessonTrackId'],
      });

      if (lessonAttempts.length > 0) {
        throw new BadRequestException(
          RESPONSE_MESSAGES.ERROR.CANNOT_DELETE_ENROLLMENT_WITH_ATTEMPTS,
        );
      }

      // Get all modules for this course to delete module tracking records
      const modules = await queryRunner.manager.find(CourseModule, {
        where: {
          courseId,
          tenantId,
          organisationId,
        },
        select: ['moduleId'],
      });

      if (modules.length > 0) {
        const moduleIds = modules.map((m) => m.moduleId);

        // Delete module tracking records
        await queryRunner.manager.delete(ModuleTrack, {
          userId,
          tenantId,
          organisationId,
          moduleId: In(moduleIds),
        });
      }

      // Delete course tracking record
      await queryRunner.manager.delete(CourseTrack, {
        courseId,
        userId,
        tenantId,
        organisationId,
      });

      // Delete the enrollment
      await queryRunner.manager.delete(UserEnrollment, {
        courseId,
        userId,
        tenantId,
        organisationId,
      });

      // Commit the transaction
      await queryRunner.commitTransaction();

      // Invalidate all related caches
      await Promise.all([
        this.cacheService.del(
          this.cacheConfig.getUserEnrollmentKey(
            enrollment.enrollmentId,
            tenantId,
            organisationId,
          ),
        ),
        this.cacheService.del(
          this.cacheConfig.getEnrollmentKey(
            userId,
            courseId,
            tenantId,
            organisationId,
          ),
        ),
        this.cacheService.invalidateEnrollment(
          userId,
          courseId,
          tenantId,
          organisationId,
        ),
      ]);

      return {
        success: true,
        message: RESPONSE_MESSAGES.ENROLLMENT_DELETED,
      };
    } catch (error) {
      // Rollback the transaction on error
      await queryRunner.rollbackTransaction();

      this.logger.error(`Error hard deleting enrollment: ${error.message}`);
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new InternalServerErrorException(RESPONSE_MESSAGES.DELETE_ERROR);
    } finally {
      // Release the query runner
      await queryRunner.release();
    }
  }
}
