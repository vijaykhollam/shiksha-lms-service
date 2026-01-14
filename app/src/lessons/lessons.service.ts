import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, FindOneOptions, FindOptionsWhere, In } from 'typeorm';
import axios from 'axios';
import {
  Lesson,
  LessonStatus,
  AttemptsGradeMethod,
  LessonFormat,
} from './entities/lesson.entity';
import { Course, CourseStatus } from '../courses/entities/course.entity';
import { Module, ModuleStatus } from '../modules/entities/module.entity';
import { Media, MediaStatus } from '../media/entities/media.entity';
import { LessonTrack } from '../tracking/entities/lesson-track.entity';
import {
  UserEnrollment,
  EnrollmentStatus,
} from '../enrollments/entities/user-enrollment.entity';
import { CreateLessonDto } from './dto/create-lesson.dto';
import { UpdateLessonDto } from './dto/update-lesson.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { HelperUtil } from '../common/utils/helper.util';
import { RESPONSE_MESSAGES } from '../common/constants/response-messages.constant';
import { CacheService } from '../cache/cache.service';
import { ConfigService } from '@nestjs/config';
import { CacheConfigService } from '../cache/cache-config.service';
import { OrderingService } from '../common/services/ordering.service';
import { AssociatedFile } from '../media/entities/associated-file.entity';
import { SearchLessonDto } from './dto/search-lesson.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class LessonsService {
  private readonly logger = new Logger(LessonsService.name);
  constructor(
    @InjectRepository(Lesson)
    private readonly lessonRepository: Repository<Lesson>,
    @InjectRepository(Course)
    private readonly courseRepository: Repository<Course>,
    @InjectRepository(Module)
    private readonly moduleRepository: Repository<Module>,
    @InjectRepository(Media)
    private readonly mediaRepository: Repository<Media>,
    @InjectRepository(LessonTrack)
    private readonly lessonTrackRepository: Repository<LessonTrack>,
    @InjectRepository(UserEnrollment)
    private readonly userEnrollmentRepository: Repository<UserEnrollment>,
    private readonly cacheService: CacheService,
    private readonly configService: ConfigService,
    private readonly cacheConfig: CacheConfigService,
    private readonly orderingService: OrderingService,
  ) {}

  /**
   * Create a new lesson with optional course association
   * @param createLessonDto The lesson data to create
   * @param userId The user ID for data isolation
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   * @param image Optional image file for the lesson
   * @returns The created lesson or course lesson association
   */
  async create(
    createLessonDto: CreateLessonDto,
    userId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<Lesson> {
    try {
      // Validate course and module existence if provided
      if (createLessonDto.courseId) {
        // Check if course exists
        const course = await this.courseRepository.findOne({
          where: {
            courseId: createLessonDto.courseId,
            status: Not(CourseStatus.ARCHIVED),
            tenantId,
            organisationId,
          },
        });

        if (!course) {
          throw new NotFoundException(RESPONSE_MESSAGES.ERROR.COURSE_NOT_FOUND);
        }

        // If moduleId is provided, validate it belongs to the course
        if (createLessonDto.moduleId) {
          const module = await this.moduleRepository.findOne({
            where: {
              moduleId: createLessonDto.moduleId,
              courseId: createLessonDto.courseId,
              status: Not(ModuleStatus.ARCHIVED),
              tenantId,
              organisationId,
            },
          });

          if (!module) {
            throw new NotFoundException(
              RESPONSE_MESSAGES.ERROR.MODULE_NOT_FOUND_IN_COURSE(
                createLessonDto.moduleId,
              ),
            );
          }
        }
      }

      if (!createLessonDto.alias) {
        createLessonDto.alias = await HelperUtil.generateUniqueAliasWithRepo(
          createLessonDto.title,
          this.lessonRepository,
          tenantId,
          organisationId,
        );
      } else {
        // Check if the alias already exists
        const whereClause: any = {
          alias: createLessonDto.alias,
          status: Not(LessonStatus.ARCHIVED),
        };

        // Add tenant and org filters if they exist
        if (tenantId) {
          whereClause.tenantId = tenantId;
        }

        if (organisationId) {
          whereClause.organisationId = organisationId;
        }

        const existingLesson = await this.lessonRepository.findOne({
          where: whereClause,
        });

        if (existingLesson) {
          // Generate a unique alias since it already exists
          const originalAlias =
            createLessonDto.alias || createLessonDto.title || 'untitled-lesson';
          createLessonDto.alias = await HelperUtil.generateUniqueAliasWithRepo(
            originalAlias,
            this.lessonRepository,
            tenantId,
            organisationId,
          );
          this.logger.log(
            `Alias '${originalAlias}' already exists. Generated new alias: ${createLessonDto.alias}`,
          );
        }
      }

      let mediaId: string;
      let storage: string = 'local';
      if (createLessonDto.format === LessonFormat.DOCUMENT) {
        storage = this.configService.get('cloud_storage_provider') || 'local';
      }

      // Create new media for all formats
      const mediaData: Partial<Media> = {
        tenantId: tenantId,
        organisationId: organisationId,
        format: createLessonDto.format,
        subFormat: createLessonDto.mediaContentSubFormat,
        source: createLessonDto.mediaContentSource || undefined,
        path: createLessonDto.mediaContentPath || undefined,
        storage: storage,
        createdBy: userId,
        updatedBy: userId,
      };

      const media = this.mediaRepository.create(mediaData);
      const savedMedia = await this.mediaRepository.save(media);
      mediaId = savedMedia.mediaId;
      // Get next ordering if not provided
      let ordering = createLessonDto.ordering;
      if (
        (ordering === undefined || ordering === null) &&
        createLessonDto.moduleId &&
        createLessonDto.courseId
      ) {
        ordering = await this.orderingService.getNextLessonOrder(
          createLessonDto.moduleId,
          createLessonDto.courseId,
          tenantId,
          organisationId,
        );
      } else if (ordering === undefined || ordering === null) {
        ordering = 0; // Default ordering if no moduleId
      }

      // Create lesson data
      const lessonData = {
        title: createLessonDto.title,
        alias: createLessonDto.alias,
        format: createLessonDto.format,
        subFormat: createLessonDto.mediaContentSubFormat, // Store subFormat in lesson table
        parentId: createLessonDto.parentId || undefined,
        mediaId,
        image: createLessonDto.image,
        description: createLessonDto.description,
        status: createLessonDto.status || LessonStatus.PUBLISHED,
        startDatetime: createLessonDto.startDatetime
          ? new Date(createLessonDto.startDatetime)
          : undefined,
        endDatetime: createLessonDto.endDatetime
          ? new Date(createLessonDto.endDatetime)
          : undefined,
        storage: storage,
        noOfAttempts: createLessonDto.noOfAttempts || 0,
        attemptsGrade:
          createLessonDto.attemptsGrade || AttemptsGradeMethod.LAST_ATTEMPT,
        prerequisites: createLessonDto.prerequisites,
        idealTime: createLessonDto.idealTime,
        resume: createLessonDto.resume,
        totalMarks: createLessonDto.totalMarks,
        passingMarks: createLessonDto.passingMarks,
        params: createLessonDto.params || {},
        ordering,
        createdBy: userId,
        updatedBy: userId,
        tenantId: tenantId,
        organisationId: organisationId,
        // Course-specific fields
        courseId: createLessonDto.courseId,
        moduleId: createLessonDto.moduleId,
        sampleLesson: createLessonDto.sampleLesson,
        considerForPassing: createLessonDto.considerForPassing,
        allowResubmission: createLessonDto.allowResubmission,
      };

      // Validate associated lesson if provided
      if (createLessonDto.associatedLesson) {
        const associatedLesson = await this.lessonRepository.findOne({
          where: {
            lessonId: createLessonDto.associatedLesson,
            tenantId,
            organisationId,
          },
          select: ['lessonId', 'parentId'],
        });

        if (!associatedLesson) {
          throw new NotFoundException(RESPONSE_MESSAGES.ERROR.LESSON_NOT_FOUND);
        }

        if (associatedLesson.parentId) {
          throw new BadRequestException(
            RESPONSE_MESSAGES.ERROR.ASSOCIATED_LESSON_ALREADY_HAS_PARENT,
          );
        }
      }

      // Create and save the lesson
      const lesson = this.lessonRepository.create(lessonData);
      const savedLesson = await this.lessonRepository.save(lesson);

      // If associatedLessonId is provided, update that lesson's parentId to point to this new lesson
      if (createLessonDto.associatedLesson) {
        await this.lessonRepository.update(
          {
            lessonId: createLessonDto.associatedLesson,
            tenantId,
            organisationId,
          },
          {
            parentId: savedLesson.lessonId,
            updatedBy: userId,
            updatedAt: new Date(),
          },
        );

        // Invalidate cache for the associated lesson
        const associatedLessonKey = this.cacheConfig.getLessonKey(
          createLessonDto.associatedLesson,
          tenantId,
          organisationId,
        );
        await this.cacheService.del(associatedLessonKey);
      }

      // Cache the new lesson with proper key and TTL
      const lessonKey = this.cacheConfig.getLessonKey(
        savedLesson.lessonId,
        tenantId,
        organisationId,
      );
      await Promise.all([
        this.cacheService.set(
          lessonKey,
          savedLesson,
          this.cacheConfig.LESSON_TTL,
        ),
        this.cacheService.invalidateLesson(
          savedLesson.lessonId,
          savedLesson.moduleId,
          savedLesson.courseId,
          tenantId,
          organisationId,
        ),
      ]);
      return savedLesson;
    } catch (error) {
      this.logger.error(`Error creating lesson: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Find all lessons with pagination and filters
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   * @param paginationDto Pagination parameters
   * @param status Optional status filter
   * @param format Optional format filter
   * @param subFormat Optional sub-format filter
   * @param query Optional search query for title and description
   * @param cohort Optional cohort filter from course params
   * @param courseId Optional course ID filter
   * @param moduleId Optional module ID filter
   */
  async getLessons(
    tenantId: string,
    organisationId: string,
    paginationDto: PaginationDto,
    searchDto: SearchLessonDto,
  ): Promise<{
    totalElements: number;
    offset: number;
    limit: number;
    lessons: Lesson[];
  }> {
    try {
      const { limit = 10 } = paginationDto;
      const offset = paginationDto.skip || 0;

      // Generate cache key using standardized pattern - include all filters for proper caching
      const cacheKey =
        this.cacheConfig.getLessonPattern(tenantId, organisationId) +
        (searchDto.cohortId ? `:cohortId:${searchDto.cohortId}` : '') +
        (searchDto.courseId ? `:courseId:${searchDto.courseId}` : '') +
        (searchDto.moduleId ? `:moduleId:${searchDto.moduleId}` : '') +
        (searchDto.format ? `:format:${searchDto.format}` : '') +
        (searchDto.subFormat ? `:subFormat:${searchDto.subFormat}` : '') +
        (searchDto.status ? `:status:${searchDto.status}` : '') +
        (searchDto.query ? `:query:${searchDto.query}` : '') +
        `:offset:${offset}:limit:${limit}`;

      // Try to get from cache first
      const cachedResult = await this.cacheService.get<{
        totalElements: number;
        offset: number;
        limit: number;
        lessons: Lesson[];
      }>(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }

      // Execute query with pagination and joins to ensure only published courses and modules
      let queryBuilder = this.lessonRepository
        .createQueryBuilder('lesson')
        .leftJoinAndSelect('lesson.media', 'media')
        .where('lesson.status != :archivedStatus', {
          archivedStatus: LessonStatus.ARCHIVED,
        })
        .andWhere('lesson.tenantId = :tenantId', { tenantId })
        .andWhere('lesson.organisationId = :organisationId', {
          organisationId,
        });

      // Add optional filters
      if (searchDto.status) {
        queryBuilder = queryBuilder.andWhere('lesson.status = :status', {
          status: searchDto.status,
        });
      }

      if (searchDto.format) {
        queryBuilder = queryBuilder.andWhere('lesson.format = :format', {
          format: searchDto.format,
        });
      }

      if (searchDto.subFormat) {
        queryBuilder = queryBuilder.andWhere('media.subFormat = :subFormat', {
          subFormat: searchDto.subFormat,
        });
      }

      // Add search query filter for title and description
      if (searchDto.query) {
        queryBuilder = queryBuilder.andWhere(
          '(lesson.title ILIKE :query OR lesson.description ILIKE :query)',
          { query: `%${searchDto.query}%` },
        );
      }

      // Add course ID filter
      if (searchDto.courseId || searchDto.cohortId) {
        queryBuilder = queryBuilder.leftJoin('lesson.course', 'course');
        queryBuilder = queryBuilder.andWhere('course.status != :courseStatus', {
          courseStatus: CourseStatus.ARCHIVED,
        });
        // Add cohort filter (search in course.params.cohort)
        if (searchDto.cohortId) {
          console.log('cohortId', searchDto.cohortId);
          queryBuilder = queryBuilder.andWhere(
            "course.params->>'cohortId' = :cohortId",
            { cohortId: searchDto.cohortId },
          );
        }
        if (searchDto.courseId) {
          queryBuilder = queryBuilder.andWhere('lesson.courseId = :courseId', {
            courseId: searchDto.courseId,
          });
        }
      }

      // Add module ID filter
      if (searchDto.moduleId) {
        queryBuilder = queryBuilder.leftJoin('lesson.module', 'module');
        queryBuilder = queryBuilder.andWhere(
          '(module.status != :moduleStatus OR module.status IS NULL)',
          { moduleStatus: ModuleStatus.ARCHIVED },
        );
        queryBuilder = queryBuilder.andWhere('lesson.moduleId = :moduleId', {
          moduleId: searchDto.moduleId,
        });
      }

      const [lessons, totalElements] = await queryBuilder
        .skip(offset)
        .take(limit)
        .orderBy('lesson.createdAt', 'DESC')
        .getManyAndCount();

      const result = { totalElements, offset, limit, lessons };

      // Cache the result
      await this.cacheService.set(
        cacheKey,
        result,
        this.cacheConfig.LESSON_TTL,
      );

      return result;
    } catch (error) {
      this.logger.error(`Error finding lessons: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Find one lesson by ID
   * @param lessonId The lesson ID to find
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   */
  async findOne(
    lessonId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<Lesson> {
    // Check cache first
    const cacheKey = this.cacheConfig.getLessonKey(
      lessonId,
      tenantId,
      organisationId,
    );
    const cachedLesson = await this.cacheService.get<Lesson>(cacheKey);
    if (cachedLesson) {
      return cachedLesson;
    }

    // Build where clause with required filters
    const whereClause: any = {
      lessonId,
      tenantId: tenantId,
      organisationId: organisationId,
      status: Not(LessonStatus.ARCHIVED),
    };

    const lesson = await this.lessonRepository.findOne({
      where: whereClause,
      relations: ['media', 'associatedFiles.media', 'associatedLesson'],
    });

    if (!lesson) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.LESSON_NOT_FOUND);
    }

    // Cache the lesson
    await this.cacheService.set(cacheKey, lesson, this.cacheConfig.LESSON_TTL);

    return lesson;
  }

  /**
   * Find lessons by module ID
   * @param moduleId The module ID to filter by
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   */
  async findByModule(
    moduleId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<Lesson[]> {
    // Check cache first
    const cacheKey = this.cacheConfig.getModuleLessonsPattern(
      moduleId,
      tenantId,
      organisationId,
    );
    const cachedLessons = await this.cacheService.get<Lesson[]>(cacheKey);
    if (cachedLessons) {
      return cachedLessons;
    }

    // Build where clause for module validation
    const moduleWhereClause: any = {
      moduleId,
      status: Not(ModuleStatus.ARCHIVED as any),
      tenantId: tenantId,
      organisationId: organisationId,
    };

    // Validate module exists with tenant/org filtering
    const module = await this.moduleRepository.findOne({
      where: moduleWhereClause,
    });

    if (!module) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.MODULE_NOT_FOUND);
    }

    // Get all lessons for this module with filtering
    const lessons = await this.lessonRepository.find({
      where: {
        moduleId,
        status: Not(LessonStatus.ARCHIVED),
        tenantId: tenantId,
        organisationId: organisationId,
      },
      order: { ordering: 'ASC' },
      relations: ['media', 'associatedFiles.media'],
    });

    // Cache the lessons
    await this.cacheService.set(cacheKey, lessons, this.cacheConfig.LESSON_TTL);

    return lessons;
  }

  /**
   * Find lesson by test ID through media source
   * @param testId The test ID to find the associated lesson
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   */
  async findByTestId(
    testId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<Lesson> {
    try {
      // Check cache first
      const cacheKey = this.cacheConfig.getLessonByTestPattern(
        testId,
        tenantId,
        organisationId,
      );
      const cachedLesson = await this.cacheService.get<Lesson>(cacheKey);
      if (cachedLesson) {
        return cachedLesson;
      }

      // Find media with the testId as source
      const media = await this.mediaRepository.findOne({
        where: {
          source: testId,
          status: Not(MediaStatus.ARCHIVED),
          tenantId: tenantId,
          organisationId: organisationId,
        },
      });

      if (!media) {
        throw new NotFoundException(RESPONSE_MESSAGES.ERROR.MEDIA_NOT_FOUND);
      }

      // Find lesson associated with this media
      const lesson = await this.lessonRepository
        .createQueryBuilder('lesson')
        .leftJoinAndSelect('lesson.course', 'course')
        .leftJoinAndSelect('lesson.module', 'module')
        .select([
          'lesson.lessonId',
          'module.moduleId',
          'course.courseId',
          'lesson.title',
          'lesson.format',
          'lesson.status',
          'course.title',
          'module.title',
        ])
        .where('lesson.mediaId = :mediaId', { mediaId: media.mediaId })
        .andWhere('lesson.status != :status', { status: LessonStatus.ARCHIVED })
        .andWhere('lesson.tenantId = :tenantId', { tenantId })
        .andWhere('lesson.organisationId = :organisationId', { organisationId })
        .getOne();

      if (!lesson) {
        throw new NotFoundException(RESPONSE_MESSAGES.ERROR.LESSON_NOT_FOUND);
      }

      // Cache the lesson
      await this.cacheService.set(
        cacheKey,
        lesson,
        this.cacheConfig.LESSON_TTL,
      );

      return lesson;
    } catch (error) {
      this.logger.error(
        `Error finding lesson by test ID: ${error.message}`,
        error.stack,
      );
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(
        RESPONSE_MESSAGES.ERROR.ERROR_RETRIEVING_LESSONS,
      );
    }
  }

  /**
   * Update a lesson
   * @param lessonId The lesson ID to update
   * @param updateLessonDto The lesson data to update
   * @param image Optional image file for the lesson
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   */
  async update(
    lessonId: string,
    updateLessonDto: UpdateLessonDto,
    userId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<Lesson> {
    try {
      const lesson = await this.findOne(lessonId, tenantId, organisationId);

      if (!lesson) {
        throw new NotFoundException(RESPONSE_MESSAGES.ERROR.LESSON_NOT_FOUND);
      }

      // Validate course and module existence if provided in update
      if (updateLessonDto.courseId) {
        // Check if course exists
        const course = await this.courseRepository.findOne({
          where: {
            courseId: updateLessonDto.courseId,
            status: Not(CourseStatus.ARCHIVED),
            tenantId,
            organisationId,
          },
        });

        if (!course) {
          throw new NotFoundException(RESPONSE_MESSAGES.ERROR.COURSE_NOT_FOUND);
        }

        // If moduleId is provided, validate it belongs to the course
        if (updateLessonDto.moduleId) {
          const module = await this.moduleRepository.findOne({
            where: {
              moduleId: updateLessonDto.moduleId,
              courseId: updateLessonDto.courseId,
              status: Not(ModuleStatus.ARCHIVED),
              tenantId,
              organisationId,
            },
          });

          if (!module) {
            throw new NotFoundException(
              RESPONSE_MESSAGES.ERROR.MODULE_NOT_FOUND_IN_COURSE(
                updateLessonDto.moduleId,
              ),
            );
          }
        }
      }

      // Check if lesson has a checked out status (if that property exists)
      if (updateLessonDto.checkedOut !== undefined) {
        throw new BadRequestException(
          RESPONSE_MESSAGES.ERROR.LESSON_CHECKED_OUT,
        );
      }

      // Parse JSON params if they are provided as a string
      if (
        updateLessonDto.params &&
        typeof updateLessonDto.params === 'string'
      ) {
        try {
          updateLessonDto.params = JSON.parse(updateLessonDto.params);
        } catch (error) {
          this.logger.error(`Error parsing params JSON: ${error.message}`);
          throw new BadRequestException(
            RESPONSE_MESSAGES.ERROR.INVALID_PARAMS_FORMAT,
          );
        }
      }

      // Get the current media
      const currentMedia = lesson.mediaId
        ? await this.mediaRepository.findOne({
            where: { mediaId: lesson.mediaId },
          })
        : null;

      // For other formats
      // Validate format matches lesson format
      if (updateLessonDto.format && updateLessonDto.format !== lesson.format) {
        throw new BadRequestException(
          RESPONSE_MESSAGES.ERROR.CANNOT_CHANGE_FORMAT,
        );
      }

      if (!currentMedia) {
        throw new NotFoundException(RESPONSE_MESSAGES.ERROR.MEDIA_NOT_FOUND);
      }

      let storage: string = 'local';
      if (updateLessonDto.format === LessonFormat.DOCUMENT) {
        storage = this.configService.get('cloud_storage_provider') || 'local';
      }

      // Update the media content
      await this.mediaRepository.update(currentMedia.mediaId, {
        tenantId: tenantId,
        organisationId: organisationId,
        format: lesson.format as LessonFormat,
        subFormat: updateLessonDto.mediaContentSubFormat,
        source: updateLessonDto.mediaContentSource,
        path: updateLessonDto.mediaContentPath,
        storage: storage,
        updatedBy: userId,
        updatedAt: new Date(),
      });

      // If title is changed but no alias provided, generate one from the title
      if (
        updateLessonDto.title &&
        updateLessonDto.title !== lesson.title &&
        !updateLessonDto.alias
      ) {
        updateLessonDto.alias = await HelperUtil.generateUniqueAliasWithRepo(
          updateLessonDto.title,
          this.lessonRepository,
          tenantId || '',
          organisationId,
        );
      }

      // Check for alias uniqueness if alias is being updated
      if (updateLessonDto.alias && updateLessonDto.alias !== lesson.alias) {
        const whereClause: any = {
          alias: updateLessonDto.alias,
          lessonId: Not(lessonId),
          status: Not(LessonStatus.ARCHIVED),
          tenantId: tenantId,
          organisationId: organisationId,
        };

        const existingLesson = await this.lessonRepository.findOne({
          where: whereClause,
        });

        // If the alias already exists, generate a new unique one
        if (existingLesson) {
          const originalAlias =
            updateLessonDto.alias || updateLessonDto.title || 'untitled-lesson';
          updateLessonDto.alias = await HelperUtil.generateUniqueAliasWithRepo(
            originalAlias,
            this.lessonRepository,
            tenantId || '',
            organisationId,
          );
          this.logger.log(
            `Alias '${originalAlias}' already exists. Generated new alias: ${updateLessonDto.alias}`,
          );
        }
      }

      // Map DTO properties to entity properties that exist in the DTO
      const updateData: any = {
        updatedBy: userId,
        updatedAt: new Date(),
      };

      // Map fields that exist in both DTO and entity
      if (updateLessonDto.title !== undefined) {
        updateData.title = updateLessonDto.title;
      }

      if (updateLessonDto.description !== undefined) {
        updateData.description = updateLessonDto.description;
      }

      if (updateLessonDto.status !== undefined) {
        updateData.status = updateLessonDto.status;
      }

      if (updateLessonDto.alias !== undefined) {
        updateData.alias = updateLessonDto.alias;
      }
      if (
        updateLessonDto.startDatetime !== undefined &&
        updateLessonDto.startDatetime !== null &&
        updateLessonDto.startDatetime !== ''
      ) {
        updateData.startDatetime = new Date(updateLessonDto.startDatetime);
      }

      if (
        updateLessonDto.endDatetime !== undefined &&
        updateLessonDto.endDatetime !== null &&
        updateLessonDto.endDatetime !== ''
      ) {
        updateData.endDatetime = new Date(updateLessonDto.endDatetime);
      }

      if (updateLessonDto.storage !== undefined) {
        updateData.storage = updateLessonDto.storage;
      }

      if (updateLessonDto.noOfAttempts !== undefined) {
        updateData.noOfAttempts = updateLessonDto.noOfAttempts;
      }

      if (updateLessonDto.attemptsGrade !== undefined) {
        updateData.attemptsGrade = updateLessonDto.attemptsGrade;
      }

      if (updateLessonDto.prerequisites !== undefined) {
        updateData.prerequisites = updateLessonDto.prerequisites;
      }

      if (updateLessonDto.idealTime !== undefined) {
        updateData.idealTime = updateLessonDto.idealTime;
      }

      if (updateLessonDto.resume !== undefined) {
        updateData.resume = updateLessonDto.resume;
      }

      if (updateLessonDto.totalMarks !== undefined) {
        updateData.totalMarks = updateLessonDto.totalMarks;
      }

      if (updateLessonDto.passingMarks !== undefined) {
        updateData.passingMarks = updateLessonDto.passingMarks;
      }

      // Handle subFormat field mapping
      if (updateLessonDto.mediaContentSubFormat !== undefined) {
        updateData.subFormat = updateLessonDto.mediaContentSubFormat;
      }

      // Handle image field mapping
      if (updateLessonDto.image) {
        updateData.image = updateLessonDto.image;
      }

      if (updateLessonDto.params !== undefined) {
        updateData.params = updateLessonDto.params;
      }

      // Handle course and module association fields
      if (updateLessonDto.courseId !== undefined) {
        updateData.courseId = updateLessonDto.courseId;
      }

      if (updateLessonDto.moduleId !== undefined) {
        updateData.moduleId = updateLessonDto.moduleId;
      }

      if (updateLessonDto.considerForPassing !== undefined) {
        updateData.considerForPassing = updateLessonDto.considerForPassing;
      }

      if (updateLessonDto.parentId !== undefined) {
        updateData.parentId = updateLessonDto.parentId;
      }

      if (updateLessonDto.allowResubmission !== undefined) {
        updateData.allowResubmission = updateLessonDto.allowResubmission;
      }

      // Validate associated lesson if provided (and not null)
      if (
        updateLessonDto.associatedLesson !== undefined &&
        updateLessonDto.associatedLesson !== null
      ) {
        const associatedLesson = await this.lessonRepository.findOne({
          where: {
            lessonId: updateLessonDto.associatedLesson,
            tenantId,
            organisationId,
          },
          select: ['lessonId', 'parentId'],
        });
        if (!associatedLesson) {
          throw new NotFoundException(RESPONSE_MESSAGES.ERROR.LESSON_NOT_FOUND);
        }

        if (
          associatedLesson.parentId !== null &&
          associatedLesson.parentId !== lessonId
        ) {
          throw new BadRequestException(
            RESPONSE_MESSAGES.ERROR.ASSOCIATED_LESSON_ALREADY_HAS_PARENT,
          );
        }
      }

      // Update the lesson
      const updatedLesson = this.lessonRepository.merge(lesson, updateData);
      const savedLesson = await this.lessonRepository.save(updatedLesson);

      // Handle associatedLesson changes only if it's explicitly provided in the update
      if (updateLessonDto.associatedLesson !== undefined) {
        if (updateLessonDto.associatedLesson === null) {
          // If explicitly set to null, clear all child lesson relationships
          const childLessons = await this.lessonRepository.find({
            where: {
              parentId: lessonId,
              tenantId,
              organisationId,
            },
          });

          // Clear the parent relationship for all child lessons
          if (childLessons.length > 0) {
            await this.lessonRepository
              .createQueryBuilder()
              .update()
              .set({
                parentId: null,
                updatedBy: userId,
                updatedAt: new Date(),
              })
              .where('parentId = :lessonId', { lessonId })
              .andWhere('tenantId = :tenantId', { tenantId })
              .andWhere('organisationId = :organisationId', { organisationId })
              .execute();
          }
        } else {
          // If a specific lesson ID is provided, set that lesson's parentId to this lesson
          // First, clear any existing child relationships for this lesson
          const existingChildLessons = await this.lessonRepository.find({
            where: {
              parentId: lessonId,
              tenantId,
              organisationId,
            },
          });

          if (existingChildLessons.length > 0) {
            await this.lessonRepository
              .createQueryBuilder()
              .update()
              .set({
                parentId: null,
                updatedBy: userId,
                updatedAt: new Date(),
              })
              .where('parentId = :lessonId', { lessonId })
              .andWhere('tenantId = :tenantId', { tenantId })
              .andWhere('organisationId = :organisationId', { organisationId })
              .execute();
          }

          // Now set the new associated lesson's parentId to this lesson
          await this.lessonRepository
            .createQueryBuilder()
            .update()
            .set({
              parentId: lessonId,
              updatedBy: userId,
              updatedAt: new Date(),
            })
            .where('lessonId = :associatedLesson', {
              associatedLesson: updateLessonDto.associatedLesson,
            })
            .andWhere('tenantId = :tenantId', { tenantId })
            .andWhere('organisationId = :organisationId', { organisationId })
            .execute();

          // Invalidate cache for the associated lesson
          const associatedLessonKey = this.cacheConfig.getLessonKey(
            updateLessonDto.associatedLesson,
            tenantId,
            organisationId,
          );
          await this.cacheService.del(associatedLessonKey);
        }
      }
      // If associatedLesson is not provided (undefined), do nothing - keep existing associations

      // Update cache and invalidate related caches
      const lessonKey = this.cacheConfig.getLessonKey(
        savedLesson.lessonId,
        tenantId,
        organisationId,
      );
      await Promise.all([
        this.cacheService.set(
          lessonKey,
          savedLesson,
          this.cacheConfig.LESSON_TTL,
        ),
        this.cacheService.invalidateLesson(
          lessonId,
          lesson.moduleId,
          lesson.courseId,
          tenantId,
          organisationId,
        ),
      ]);

      return await this.findOne(savedLesson.lessonId, tenantId, organisationId);
    } catch (error) {
      this.logger.error(`Error updating lesson: ${error.message}`);
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new InternalServerErrorException(
        RESPONSE_MESSAGES.ERROR.ERROR_UPDATING_LESSON,
      );
    }
  }

  /**
   * Remove a lesson (archive it)
   * @param lessonId The lesson ID to remove
   * @param userId The user ID for data isolation
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   */
  async remove(
    lessonId: string,
    userId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const lesson = await this.findOne(lessonId, tenantId, organisationId);

      if (!lesson) {
        throw new NotFoundException(RESPONSE_MESSAGES.ERROR.LESSON_NOT_FOUND);
      }

      // Check if lesson's course has active enrollments
      if (lesson.courseId) {
        const activeEnrollments = await this.userEnrollmentRepository.count({
          where: {
            courseId: lesson.courseId,
            tenantId,
            organisationId,
            status: EnrollmentStatus.PUBLISHED,
          },
        });

        if (activeEnrollments > 0) {
          throw new BadRequestException(
            `Cannot delete lesson. The course has ${activeEnrollments} active enrollment(s). Please cancel all enrollments first.`,
          );
        }
      }

      // Soft delete by updating status
      lesson.status = LessonStatus.ARCHIVED;
      lesson.updatedBy = userId;
      await this.lessonRepository.save(lesson);

      // Invalidate all related caches
      const lessonKey = this.cacheConfig.getLessonKey(
        lessonId,
        tenantId,
        organisationId,
      );
      await Promise.all([
        this.cacheService.del(lessonKey),
        this.cacheService.invalidateLesson(
          lessonId,
          lesson.moduleId,
          lesson.courseId,
          tenantId,
          organisationId,
        ),
      ]);

      return {
        success: true,
        message: 'Lesson deleted successfully',
      };
    } catch (error) {
      this.logger.error(`Error removing lesson: ${error.message}`);
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new InternalServerErrorException(
        RESPONSE_MESSAGES.ERROR.ERROR_REMOVING_LESSON,
      );
    }
  }

  /**
   * Archive multiple lessons by module ID (for cascading soft deletes)
   * @param moduleId The module ID whose lessons should be archived
   * @param userId The user ID for audit trail
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   */
  async archiveLessonsByModule(
    moduleId: string,
    userId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<{ success: boolean; message: string; archivedCount: number }> {
    try {
      // Find all lessons for the module
      const lessons = await this.lessonRepository.find({
        where: {
          moduleId,
          tenantId,
          organisationId,
          status: Not(LessonStatus.ARCHIVED),
        },
        select: ['lessonId', 'status'],
      });

      if (lessons.length === 0) {
        return {
          success: true,
          message: 'No lessons found to archive',
          archivedCount: 0,
        };
      }

      // Archive all lessons
      const lessonIds = lessons.map((lesson) => lesson.lessonId);
      await this.lessonRepository.update(
        { lessonId: In(lessonIds) },
        {
          status: LessonStatus.ARCHIVED,
          updatedBy: userId,
          updatedAt: new Date(),
        },
      );

      // Invalidate related caches
      await Promise.all([
        ...lessonIds.map((lessonId) =>
          this.cacheService.invalidateLesson(
            lessonId,
            moduleId,
            '',
            tenantId,
            organisationId,
          ),
        ),
        this.cacheService.invalidateModule(
          moduleId,
          '',
          tenantId,
          organisationId,
        ),
      ]);

      this.logger.log(
        `Archived ${lessons.length} lessons for module ${moduleId}`,
      );

      return {
        success: true,
        message: `Successfully archived ${lessons.length} lessons`,
        archivedCount: lessons.length,
      };
    } catch (error) {
      this.logger.error(
        `Error archiving lessons for module ${moduleId}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        RESPONSE_MESSAGES.ERROR.ERROR_REMOVING_LESSON,
      );
    }
  }

  /**
   * Archive multiple lessons by course ID (for cascading soft deletes)
   * @param courseId The course ID whose lessons should be archived
   * @param userId The user ID for audit trail
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   */
  async archiveLessonsByCourse(
    courseId: string,
    userId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<{ success: boolean; message: string; archivedCount: number }> {
    try {
      // Find all lessons for the course
      const lessons = await this.lessonRepository.find({
        where: {
          courseId,
          tenantId,
          organisationId,
          status: Not(LessonStatus.ARCHIVED),
        },
        select: ['lessonId', 'moduleId', 'status'],
      });

      if (lessons.length === 0) {
        return {
          success: true,
          message: 'No lessons found to archive',
          archivedCount: 0,
        };
      }

      // Archive all lessons
      const lessonIds = lessons.map((lesson) => lesson.lessonId);
      await this.lessonRepository.update(
        { lessonId: In(lessonIds) },
        {
          status: LessonStatus.ARCHIVED,
          updatedBy: userId,
          updatedAt: new Date(),
        },
      );

      // Invalidate related caches
      await Promise.all([
        ...lessons.map((lesson) =>
          this.cacheService.invalidateLesson(
            lesson.lessonId,
            lesson.moduleId,
            courseId,
            tenantId,
            organisationId,
          ),
        ),
        this.cacheService.invalidateCourse(courseId, tenantId, organisationId),
      ]);

      this.logger.log(
        `Archived ${lessons.length} lessons for course ${courseId}`,
      );

      return {
        success: true,
        message: `Successfully archived ${lessons.length} lessons`,
        archivedCount: lessons.length,
      };
    } catch (error) {
      this.logger.error(
        `Error archiving lessons for course ${courseId}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        RESPONSE_MESSAGES.ERROR.ERROR_REMOVING_LESSON,
      );
    }
  }

  /**
   * Clone lessons for a module using transaction
   */
  public async cloneLessonsWithTransaction(
    originalModuleId: string,
    newModuleId: string,
    userId: string,
    tenantId: string,
    organisationId: string,
    transactionalEntityManager: any,
    newCourseId: string,
    authorization: string,
  ): Promise<void> {
    try {
      // Get all lessons for the original module
      const lessons = await transactionalEntityManager.find(Lesson, {
        where: {
          moduleId: originalModuleId,
          status: Not(LessonStatus.ARCHIVED),
          tenantId,
          organisationId,
        },
        relations: ['media', 'associatedFiles.media'],
      });

      if (!lessons || lessons.length === 0) {
        this.logger.warn(`No lessons found for module ${originalModuleId}`);
        return;
      }

      // Clone each lesson
      for (const lesson of lessons) {
        try {
          await this.cloneLessonWithTransaction(
            lesson,
            newModuleId,
            userId,
            tenantId,
            organisationId,
            transactionalEntityManager,
            newCourseId,
            authorization,
          );
        } catch (error) {
          this.logger.error(
            `Error cloning lesson ${lesson.lessonId}: ${error.message}`,
          );
          throw new Error(
            `${RESPONSE_MESSAGES.ERROR.LESSON_COPY_FAILED}: ${lesson.title}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Error in cloneLessonsWithTransaction for module ${originalModuleId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Clone a single lesson with its media using transaction
   */
  private async cloneLessonWithTransaction(
    originalLesson: Lesson,
    newModuleId: string,
    userId: string,
    tenantId: string,
    organisationId: string,
    transactionalEntityManager: any,
    newCourseId: string,
    authorization: string,
  ): Promise<Lesson | boolean> {
    try {
      if (originalLesson.format === LessonFormat.EVENT) {
        return true;
      } else {
        let newMediaId: string | undefined;

        // Clone media if lesson has media
        if (originalLesson.mediaId) {
          const originalMedia = await transactionalEntityManager.findOne(
            Media,
            {
              where: { mediaId: originalLesson.mediaId },
            },
          );

          if (originalMedia) {
            let clonedTestId = originalMedia.source;
            if (originalLesson.format === LessonFormat.ASSESSMENT) {
              clonedTestId = await this.cloneTest(
                originalMedia.source,
                organisationId,
                tenantId,
                userId,
                authorization,
              );
            }

            const newMediaData = {
              ...originalMedia,
              createdBy: userId,
              updatedBy: userId,
              source: clonedTestId,
              // Remove properties that should not be copied
              mediaId: undefined,
              // Don't set createdAt/updatedAt - let TypeORM handle them automatically
            };

            const newMedia = transactionalEntityManager.create(
              Media,
              newMediaData,
            );
            const savedMedia = await transactionalEntityManager.save(
              Media,
              newMedia,
            );

            if (!savedMedia) {
              throw new Error(
                `${RESPONSE_MESSAGES.ERROR.MEDIA_SAVE_FAILED}: ${originalLesson.title}`,
              );
            }

            newMediaId = savedMedia.mediaId;
          }
        }

        this.logger.log(`Final newMediaId value: ${newMediaId}`);

        // Create new lesson data
        const newLessonData = {
          // Copy all properties from original lesson except the ones we want to override
          title: originalLesson.title,
          alias: originalLesson.alias + '-copy',
          format: originalLesson.format,
          subFormat: originalLesson.subFormat, // Copy subFormat from original lesson
          image: originalLesson.image,
          description: originalLesson.description,
          status: originalLesson.status,
          startDatetime: originalLesson.startDatetime,
          endDatetime: originalLesson.endDatetime,
          storage: originalLesson.storage,
          noOfAttempts: originalLesson.noOfAttempts,
          attemptsGrade: originalLesson.attemptsGrade,
          prerequisites: originalLesson.prerequisites,
          idealTime: originalLesson.idealTime,
          resume: originalLesson.resume,
          totalMarks: originalLesson.totalMarks,
          passingMarks: originalLesson.passingMarks,
          params: originalLesson.params || {},
          sampleLesson: originalLesson.sampleLesson,
          considerForPassing: originalLesson.considerForPassing,
          // Explicitly preserve allowResubmission value from original lesson (true stays true, false stays false)
          // This applies to all lesson formats: feedback, quiz, assessment, reflection.prompt, etc.
          allowResubmission: originalLesson.allowResubmission,
          tenantId,
          organisationId,
          // Override with new values
          mediaId: newMediaId || null, //Use null if no new media was created
          courseId: newCourseId,
          moduleId: newModuleId,
          createdBy: userId,
          updatedBy: userId,
        };

        const newLesson = transactionalEntityManager.create(
          Lesson,
          newLessonData,
        );
        const savedLesson = await transactionalEntityManager.save(
          Lesson,
          newLesson,
        );

        if (!savedLesson) {
          throw new Error(
            `${RESPONSE_MESSAGES.ERROR.LESSON_SAVE_FAILED}: ${originalLesson.title}`,
          );
        }

        // Clone associated files if lesson has them
        if (
          originalLesson.associatedFiles &&
          originalLesson.associatedFiles.length > 0
        ) {
          try {
            await this.cloneAssociatedFilesWithTransaction(
              originalLesson.lessonId,
              savedLesson.lessonId,
              userId,
              tenantId,
              organisationId,
              transactionalEntityManager,
            );
          } catch (error) {
            this.logger.error(
              `Error cloning associated files for lesson ${originalLesson.lessonId}: ${error.message}`,
            );
            // Don't throw here as the lesson was already saved
          }
        }

        return savedLesson;
      }
    } catch (error) {
      this.logger.error(
        `Error in cloneLessonWithTransaction for lesson ${originalLesson.lessonId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Clone associated files for a lesson using transaction
   */
  private async cloneAssociatedFilesWithTransaction(
    originalLessonId: string,
    newLessonId: string,
    userId: string,
    tenantId: string,
    organisationId: string,
    transactionalEntityManager: any,
  ): Promise<void> {
    try {
      const associatedFiles = await transactionalEntityManager.find(
        AssociatedFile,
        {
          where: {
            lessonId: originalLessonId,
            tenantId,
            organisationId,
          },
          relations: ['media'],
        },
      );

      if (!associatedFiles || associatedFiles.length === 0) {
        this.logger.warn(
          `No associated files found for lesson ${originalLessonId}`,
        );
        return;
      }

      for (const associatedFile of associatedFiles) {
        try {
          let newMediaId: string | undefined;

          // Clone media if it exists
          if (associatedFile.media) {
            const originalMedia = associatedFile.media;
            const newMediaData = {
              ...originalMedia,
              createdBy: userId,
              updatedBy: userId,
              // Remove properties that should not be copied
              mediaId: undefined,
            };

            const newMedia = transactionalEntityManager.create(
              Media,
              newMediaData,
            );
            const savedMedia = await transactionalEntityManager.save(
              Media,
              newMedia,
            );

            if (!savedMedia) {
              throw new Error(RESPONSE_MESSAGES.ERROR.MEDIA_SAVE_FAILED);
            }

            newMediaId = savedMedia.mediaId;
            this.logger.log(
              `Cloned associated file media from ${originalMedia.mediaId} to ${newMediaId}`,
            );

            // Create new associated file record
            const newAssociatedFileData = {
              lessonId: newLessonId,
              mediaId: newMediaId,
              tenantId,
              organisationId,
              createdBy: userId,
              updatedBy: userId,
            };

            const newAssociatedFile = transactionalEntityManager.create(
              AssociatedFile,
              newAssociatedFileData,
            );
            const savedAssociatedFile = await transactionalEntityManager.save(
              AssociatedFile,
              newAssociatedFile,
            );

            if (!savedAssociatedFile) {
              throw new Error(
                RESPONSE_MESSAGES.ERROR.ASSOCIATED_FILE_SAVE_FAILED,
              );
            }
          }
        } catch (error) {
          this.logger.error(
            `Error cloning associated file ${associatedFile.associatedFileId}: ${error.message}`,
          );
          // Continue with other files even if one fails
        }
      }
    } catch (error) {
      this.logger.error(
        `Error in cloneAssociatedFilesWithTransaction for lesson ${originalLessonId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Clone a test from the assessment microservice
   * @param testId The test ID to clone
   * @param organisationId The organization ID for the request
   * @param tenantId The tenant ID for the request
   * @param authorization The authorization header
   * @returns The cloned test ID
   * @throws BadRequestException if the request fails or response is invalid
   */
  async cloneTest(
    testId: string,
    organisationId: string,
    tenantId: string,
    userId: string,
    authorization: string,
  ): Promise<string> {
    try {
      // Get the assessment service URL from environment
      const assessmentServiceUrl =
        this.configService.get<string>('ASSESSMENT_SERVICE_URL') || '';

      // Construct the full URL
      const url = `${assessmentServiceUrl}/tests/${testId}/clone`;

      this.logger.log(`Cloning test ${testId} from ${url}`);

      // Make the POST request using direct axios
      const response = await axios.post(
        url,
        {},
        {
          headers: {
            organisationId: organisationId,
            tenantId: tenantId,
            authorization: authorization,
            'Content-Type': 'application/json',
            userId: userId,
          },
        },
      );

      const responseData = response.data;

      // Validate response structure
      if (!responseData || !responseData.result) {
        this.logger.error(
          `Invalid response structure from assessment service: ${JSON.stringify(responseData)}`,
        );
        throw new BadRequestException(
          'Invalid response from assessment service',
        );
      }

      // Check if the operation was successful
      if (responseData.params.status !== 'successful') {
        const errorMessage =
          responseData.params.errmsg || 'Failed to clone test';
        this.logger.error(`Assessment service error: ${errorMessage}`);
        throw new BadRequestException(errorMessage);
      }

      // Extract the cloned test ID
      const clonedTestId = responseData.result.clonedTestId;
      if (!clonedTestId) {
        this.logger.error('No cloned test ID in response');
        throw new BadRequestException(
          'No cloned test ID received from assessment service',
        );
      }

      this.logger.log(`Successfully cloned test ${testId} to ${clonedTestId}`);
      return clonedTestId;
    } catch (error) {
      this.logger.error(
        `Error cloning test ${testId}: ${error.message}`,
        error.stack,
      );

      // Re-throw BadRequestException as is
      if (error instanceof BadRequestException) {
        throw error;
      }

      // Handle axios errors
      if (axios.isAxiosError(error) && error.response) {
        const status = error.response.status;
        const errorMessage =
          error.response.data?.params?.errmsg ||
          `Assessment service error (${status})`;
        throw new BadRequestException(errorMessage);
      }

      // Handle network errors
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new BadRequestException(
          'Unable to connect to assessment service',
        );
      }

      // Generic error
      throw new BadRequestException('Failed to clone test');
    }
  }

  /**
   * Clone a lesson with all its media and associated files
   */
  async cloneLesson(
    lessonId: string,
    userId: string,
    tenantId: string,
    organisationId: string,
    authorization: string,
    newCourseId: string,
    newModuleId: string,
  ): Promise<Lesson> {
    this.logger.log(`Cloning lesson: ${lessonId}`);

    try {
      // Use a database transaction to ensure data consistency
      const result = await this.lessonRepository.manager.transaction(
        async (transactionalEntityManager) => {
          // Find the original lesson
          const originalLesson = await transactionalEntityManager.findOne(
            Lesson,
            {
              where: {
                lessonId,
                tenantId,
                organisationId,
              },
              relations: ['media', 'associatedFiles.media'],
            },
          );

          if (!originalLesson) {
            throw new NotFoundException(
              RESPONSE_MESSAGES.ERROR.LESSON_NOT_FOUND,
            );
          }

          // Generate title and alias for the copied lesson
          const newTitle = `${originalLesson.title} (Copy)`;
          const newAlias = originalLesson.alias + '-copy';

          const course = await this.courseRepository.findOne({
            where: {
              courseId: newCourseId,
              tenantId,
              organisationId,
            },
          });
          if (!course) {
            throw new NotFoundException(
              RESPONSE_MESSAGES.ERROR.COURSE_NOT_FOUND,
            );
          }

          const module = await this.moduleRepository.findOne({
            where: {
              moduleId: newModuleId,
              courseId: newCourseId,
              tenantId,
              organisationId,
            },
          });
          if (!module) {
            throw new NotFoundException(
              RESPONSE_MESSAGES.ERROR.MODULE_NOT_FOUND,
            );
          }

          // Clone the lesson using the existing transaction method
          const clonedLesson = await this.cloneLessonWithTransaction(
            originalLesson,
            newModuleId,
            userId,
            tenantId,
            organisationId,
            transactionalEntityManager,
            newCourseId,
            authorization,
          );

          if (typeof clonedLesson === 'boolean') {
            throw new Error(RESPONSE_MESSAGES.ERROR.LESSON_COPY_FAILED);
          }

          // Update the title and alias
          clonedLesson.title = newTitle;
          clonedLesson.alias = newAlias;

          // Save the updated lesson
          const savedLesson = await transactionalEntityManager.save(
            Lesson,
            clonedLesson,
          );

          this.logger.log(
            `Lesson copied successfully: ${savedLesson.lessonId}`,
          );
          return savedLesson;
        },
      );

      // Handle cache operations after successful transaction
      await this.cacheService.invalidateLesson(
        lessonId,
        '',
        '',
        tenantId,
        organisationId,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Error cloning lesson ${lessonId}: ${error.message}`,
        error.stack,
      );

      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(
        RESPONSE_MESSAGES.ERROR.LESSON_COPY_FAILED,
      );
    }
  }
}
