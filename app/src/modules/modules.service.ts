import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, Not, IsNull, In, MoreThanOrEqual, LessThanOrEqual, Between } from 'typeorm';
import { Module, ModuleStatus } from './entities/module.entity';
import { Course, CourseStatus } from '../courses/entities/course.entity';
import { Lesson, LessonStatus } from '../lessons/entities/lesson.entity';
import { CourseTrack } from '../tracking/entities/course-track.entity';
import { LessonTrack } from '../tracking/entities/lesson-track.entity';
import { ModuleTrack } from '../tracking/entities/module-track.entity';
import { UserEnrollment, EnrollmentStatus } from '../enrollments/entities/user-enrollment.entity';
import { RESPONSE_MESSAGES } from '../common/constants/response-messages.constant';
import { CreateModuleDto } from './dto/create-module.dto';
import { UpdateModuleDto } from './dto/update-module.dto';
import { SearchModuleDto, SearchModuleResponseDto } from './dto/search-module.dto';
import { CacheService } from '../cache/cache.service';
import { ConfigService } from '@nestjs/config';
import { CacheConfigService } from '../cache/cache-config.service';
import { OrderingService } from '../common/services/ordering.service';
import { LessonsService } from 'src/lessons/lessons.service';

@Injectable()
export class ModulesService {
  private readonly logger = new Logger(ModulesService.name);

  constructor(
    @InjectRepository(Module)
    private readonly moduleRepository: Repository<Module>,
    @InjectRepository(Course)
    private readonly courseRepository: Repository<Course>,
    @InjectRepository(Lesson)
    private readonly lessonRepository: Repository<Lesson>,
    @InjectRepository(CourseTrack)
    private readonly courseTrackRepository: Repository<CourseTrack>,
    @InjectRepository(LessonTrack)
    private readonly lessonTrackRepository: Repository<LessonTrack>,
    @InjectRepository(ModuleTrack)
    private readonly moduleTrackRepository: Repository<ModuleTrack>,
    @InjectRepository(UserEnrollment)
    private readonly userEnrollmentRepository: Repository<UserEnrollment>,
    private readonly cacheService: CacheService,
    private readonly configService: ConfigService,
    private readonly cacheConfig: CacheConfigService,
    private readonly orderingService: OrderingService,
    private readonly lessonsService: LessonsService 
  ) {
  }

  /**
   * Create a new module
   */
  async create(
    createModuleDto: CreateModuleDto,
    userId: string,
    tenantId: string,
    organisationId?: string
  ): Promise<Module> {
    this.logger.log(`Creating module: ${JSON.stringify(createModuleDto)}`);

    // Check if the module has both courseId and parentId
    if (createModuleDto.courseId && createModuleDto.parentId) {
      // Validate that parentId belongs to the specified course
      const parentModule = await this.moduleRepository.findOne({
        where: { 
          moduleId: createModuleDto.parentId,
          courseId: createModuleDto.courseId,
          status: Not(ModuleStatus.ARCHIVED),
          tenantId,
          ...(organisationId && { organisationId }), // conditionally add organisationId if it exists
        } as FindOptionsWhere<Module>,
      });

      if (!parentModule) {
        throw new BadRequestException(RESPONSE_MESSAGES.ERROR.PARENT_MODULE_INVALID);
      }
    } 
    else if (createModuleDto.courseId) {
      // Validate that course exists
      const course = await this.courseRepository.findOne({
        where: { 
          courseId: createModuleDto.courseId,
          status: Not(CourseStatus.ARCHIVED),
          tenantId,
          ...(organisationId && { organisationId }), // conditionally add organisationId if it exists
        } as FindOptionsWhere<Course>,
      });

      if (!course) {
        throw new NotFoundException(RESPONSE_MESSAGES.ERROR.COURSE_NOT_FOUND);
      }
    } 
    else {
      // Either courseId or parentId is required
      throw new BadRequestException(RESPONSE_MESSAGES.ERROR.COURSE_OR_PARENT_REQUIRED);
    }

    // Check if a module with the same title already exists in the same context
    const existingModule = await this.moduleRepository.findOne({
      where: [
        { 
          title: createModuleDto.title, 
          courseId: createModuleDto.courseId,
          parentId: IsNull(),
          status: Not(ModuleStatus.ARCHIVED),
          tenantId,
          organisationId
        } as FindOptionsWhere<Module>,
        { 
          title: createModuleDto.title, 
          parentId: createModuleDto.parentId,
          status: Not(ModuleStatus.ARCHIVED),
          tenantId,
          organisationId
        } as FindOptionsWhere<Module>,
      ],
    });

    if (existingModule) {
      throw new ConflictException(RESPONSE_MESSAGES.ERROR.MODULE_ALREADY_EXISTS);
    }

    
    // Get next ordering if not provided
    let ordering = createModuleDto.ordering;
    if (ordering === undefined || ordering === null) {
      ordering = await this.orderingService.getNextModuleOrder(
        createModuleDto.courseId,
        createModuleDto.parentId,
        tenantId,
        organisationId
      );
    }

    // Create moduleData with only fields that exist in the entity
    const moduleData = {
      title: createModuleDto.title,
      description: createModuleDto.description,
      courseId: createModuleDto.courseId,
      parentId: createModuleDto.parentId || undefined,
      image: createModuleDto.image, 
      ordering, 
      status: createModuleDto.status || ModuleStatus.PUBLISHED,
      startDatetime: createModuleDto.startDatetime,
      endDatetime: createModuleDto.endDatetime,
      prerequisites: createModuleDto.prerequisites,
      badgeId: createModuleDto.badgeId,
      badgeTerm: createModuleDto.badgeTerm,
      params: createModuleDto.params || {}, // Map meta to params
      // Required fields
      tenantId,
      organisationId,
      createdBy: userId,
      updatedBy: userId,
    };

    // Create the module
    const module = this.moduleRepository.create(moduleData);
    const savedModule = await this.moduleRepository.save(module);

    // Extract courseId from saved module for cache invalidation
    const courseId = savedModule.courseId;

    // Cache the new module and invalidate related caches
    await Promise.all([
      this.cacheService.setModule(savedModule),
      this.cacheService.invalidateModule(savedModule.moduleId, courseId, savedModule.tenantId, savedModule.organisationId),
      // Invalidate course hierarchy cache when module is created
      courseId
        ? this.cacheService.invalidateCourseHierarchyCache(courseId)
        : Promise.resolve(),
      // Invalidate course enrollment cache when module is created
      courseId
        ? this.cacheService.invalidateCourseEnrollments(
            courseId,
            savedModule.tenantId,
            savedModule.organisationId,
          )
        : Promise.resolve(),
    ]);

    return savedModule;
  }

  /**
   * Find one module by ID
   * @param moduleId The module ID to find
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   */
  async findOne(
    moduleId: string,
    tenantId: string,
    organisationId: string
  ): Promise<Module> {
    // Check cache first
    const cacheKey = this.cacheConfig.getModuleKey(moduleId, tenantId || '', organisationId || '');
    const cachedModule = await this.cacheService.get<Module>(cacheKey);
    if (cachedModule) {
      return cachedModule;
    }

    // Build where clause with optional filters
    const whereClause: FindOptionsWhere<Module> = { moduleId };
    
    // Add tenant and org filters if provided
    if (tenantId) {
      whereClause.tenantId = tenantId;
    }
    
    if (organisationId) {
      whereClause.organisationId = organisationId;
    }
    
    const module = await this.moduleRepository.findOne({
      where: whereClause,
    });

    if (!module) {
      throw new NotFoundException(RESPONSE_MESSAGES.ERROR.MODULE_NOT_FOUND);
    }

    // Cache the module with TTL
    await this.cacheService.set(cacheKey, module, this.cacheConfig.MODULE_TTL);
    return module;
  }

  /**
   * Update a module
   */
  async update(
    moduleId: string,
    updateModuleDto: UpdateModuleDto,
    userId: string,
    tenantId: string,
    organisationId: string,
  ): Promise<Module> {
    const module = await this.findOne(moduleId, tenantId, organisationId);

      const enrichedDto = {
        ...updateModuleDto,
        updatedBy: userId,
        updatedAt: new Date(),
      };

      const updatedModule = this.moduleRepository.merge(module, enrichedDto);
      // Update the module
      const savedModule = await this.moduleRepository.save(updatedModule);

    // Extract courseId from saved module for cache invalidation
    // Use savedModule.courseId as it reflects the actual saved state (may have changed)
    const courseId = savedModule.courseId;
    const originalCourseId = module.courseId;

    // Update cache and invalidate related caches
    const moduleKey = this.cacheConfig.getModuleKey(savedModule.moduleId, savedModule.tenantId, savedModule.organisationId);
    
    // Prepare cache invalidation promises
    const cacheInvalidationPromises = [
      this.cacheService.set(moduleKey, savedModule, this.cacheConfig.MODULE_TTL),
      this.cacheService.invalidateModule(moduleId, courseId, tenantId, organisationId),
    ];

    // Invalidate course hierarchy cache when module is updated
    // If courseId changed, invalidate both old and new course hierarchy caches
    if (courseId) {
      cacheInvalidationPromises.push(
        this.cacheService.invalidateCourseHierarchyCache(courseId),
      );
      // If courseId changed, also invalidate the old course hierarchy
      if (originalCourseId && originalCourseId !== courseId) {
        cacheInvalidationPromises.push(
          this.cacheService.invalidateCourseHierarchyCache(originalCourseId),
        );
      }
    } else if (originalCourseId) {
      // If courseId was removed, invalidate the old course hierarchy
      cacheInvalidationPromises.push(
        this.cacheService.invalidateCourseHierarchyCache(originalCourseId),
      );
    }

    // Invalidate course enrollment cache when module is updated
    if (courseId) {
      cacheInvalidationPromises.push(
        this.cacheService.invalidateCourseEnrollments(
          courseId,
          tenantId,
          organisationId,
        ),
      );
      // If courseId changed, also invalidate enrollment cache for old course
      if (originalCourseId && originalCourseId !== courseId) {
        cacheInvalidationPromises.push(
          this.cacheService.invalidateCourseEnrollments(
            originalCourseId,
            tenantId,
            organisationId,
          ),
        );
      }
    } else if (originalCourseId) {
      // If courseId was removed, invalidate enrollment cache for old course
      cacheInvalidationPromises.push(
        this.cacheService.invalidateCourseEnrollments(
          originalCourseId,
          tenantId,
          organisationId,
        ),
      );
    }

    await Promise.all(cacheInvalidationPromises);

    return savedModule;
  }


  /**
   * Remove a module (archive it)
   * @param moduleId The module ID to remove
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   */
    async remove(
    moduleId: string,
    userId: string,
    tenantId: string,
    organisationId: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      const module = await this.findOne(moduleId, tenantId, organisationId);
      
      // Check if module's course has active enrollments
      const activeEnrollments = await this.userEnrollmentRepository.count({
        where: {
          courseId: module.courseId,
          tenantId,
          organisationId,
          status: EnrollmentStatus.PUBLISHED
        }
      });

      if (activeEnrollments > 0) {
        throw new BadRequestException(
          `Cannot delete module. The course has ${activeEnrollments} active enrollment(s). Please delete all enrollments first.`
        );
      }
      
      // Use a database transaction to ensure data consistency
      const result = await this.moduleRepository.manager.transaction(async (transactionalEntityManager) => {
        // Archive all lessons using bulk update
        const lessonArchiveResult = await transactionalEntityManager.update(
          Lesson,
          { 
            moduleId,
            tenantId,
            organisationId,
            status: Not(LessonStatus.ARCHIVED)
          },
          { 
            status: LessonStatus.ARCHIVED,
            updatedBy: userId,
            updatedAt: new Date()
          }
        );

        this.logger.log(`Archived ${lessonArchiveResult.affected || 0} lessons for module ${moduleId}`);

        // Archive the module
        module.status = ModuleStatus.ARCHIVED;
        module.updatedBy = userId;
        module.updatedAt = new Date();
        await transactionalEntityManager.save(Module, module);

        return { lessonArchiveResult };
      });

      // Invalidate all related caches after successful transaction
      const moduleKey = this.cacheConfig.getModuleKey(moduleId, tenantId, organisationId);
      await Promise.all([
        this.cacheService.del(moduleKey),
        this.cacheService.invalidateModule(moduleId, module.courseId, tenantId, organisationId),
        // Invalidate course enrollment cache when module is deleted
        this.cacheService.invalidateCourseEnrollments(
          module.courseId,
          tenantId,
          organisationId,
        ),
      ]);

      return {
        success: true,
        message: RESPONSE_MESSAGES.MODULE_DELETED || 'Module deleted successfully',
      };
    } catch (error) {
      this.logger.error(`Error removing module: ${error.message}`, error.stack);
      throw error;
    }
  }


  /**
   * Clone a single module with its lessons using transaction
   */
  public async cloneModuleWithTransaction(
    originalModule: Module,
    newCourseId: string,
    userId: string,
    tenantId: string,
    organisationId: string,
    transactionalEntityManager: any,
    authorization: string,
  ): Promise<Module | null> {
    try {
      // Create new module data
      const newModuleData = {
        ...originalModule,
        title: `${originalModule.title} (Copy)`,
        courseId: newCourseId,
        parentId: undefined,
        createdBy: userId,
        updatedBy: userId,
        // Remove properties that should not be copied
        moduleId: undefined,
      };

      const newModule = transactionalEntityManager.create(Module, newModuleData);
      const savedModule = await transactionalEntityManager.save(Module, newModule);

      if (!savedModule) {
        throw new Error(`${RESPONSE_MESSAGES.ERROR.MODULE_SAVE_FAILED}: ${originalModule.title}`);
      }

      // Clone lessons for this module
      await this.lessonsService.cloneLessonsWithTransaction(originalModule.moduleId, savedModule.moduleId, userId, tenantId, organisationId, transactionalEntityManager, newCourseId, authorization);

      // Clone submodules if any
      const submodules = await transactionalEntityManager.find(Module, {
        where: {
          parentId: originalModule.moduleId,
          status: Not(ModuleStatus.ARCHIVED),
          tenantId,
          organisationId,
        },
        order: { ordering: 'ASC' },
      });
       if (!submodules || submodules.length === 0) {
        this.logger.warn(`No submodules found for module ${originalModule.moduleId}`);
        return savedModule;
      }


      for (const submodule of submodules) {
        try {
          await this.cloneSubmoduleWithTransaction(submodule, savedModule.moduleId, userId, tenantId, organisationId, transactionalEntityManager, newCourseId, authorization);
        } catch (error) {
          this.logger.error(`Error cloning submodule ${submodule.moduleId}: ${error.message}`);
          throw new Error(`${RESPONSE_MESSAGES.ERROR.SUBMODULE_COPY_FAILED}: ${submodule.title}`);
        }
      }
       // Handle cache operations after successful transaction
       await this.cacheService.invalidateModule(savedModule.moduleId, newCourseId, tenantId, organisationId);


      return savedModule;
    } catch (error) {
      this.logger.error(`Error in cloneModuleWithTransaction for module ${originalModule.moduleId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Clone a submodule using transaction
   */
  public async cloneSubmoduleWithTransaction(
    originalSubmodule: Module,
    newParentId: string,
    userId: string,
    tenantId: string,
    organisationId: string,
    transactionalEntityManager: any,
    newCourseId: string,
    authorization: string,
  ): Promise<Module> {
  try {
    // Create new submodule data
    const newSubmoduleData = {
      ...originalSubmodule,
      courseId: newCourseId,
      parentId: newParentId,
      createdBy: userId,
      updatedBy: userId,
      // Remove properties that should not be copied
      moduleId: undefined,
    };

    const newSubmodule = transactionalEntityManager.create(Module, newSubmoduleData);
    const savedSubmodule = await transactionalEntityManager.save(Module, newSubmodule);

    // Clone lessons for this submodule
    await this.lessonsService.cloneLessonsWithTransaction(originalSubmodule.moduleId, savedSubmodule.moduleId, userId, tenantId, organisationId, transactionalEntityManager, newCourseId, authorization);

    return savedSubmodule;
    } catch (error) {
      this.logger.error(`Error in cloneSubmoduleWithTransaction for submodule ${originalSubmodule.moduleId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Clone a module with all its lessons and submodules
   */
  async cloneModule(
    moduleId: string,
    newCourseId: string,
    userId: string,
    tenantId: string,
    organisationId: string,
    authorization: string,
  ): Promise<Module> {
    this.logger.log(`Cloning module: ${moduleId}`);

    try {
      // Use a database transaction to ensure data consistency
      const result = await this.moduleRepository.manager.transaction(async (transactionalEntityManager) => {
       
        const module = await this.findOne(moduleId, tenantId, organisationId);
        const clonedModule = await this.cloneModuleWithTransaction(module, newCourseId, userId, tenantId, organisationId, transactionalEntityManager, authorization);
        return clonedModule;
      });
      if (!result) {
        throw new Error(RESPONSE_MESSAGES.ERROR.MODULE_COPY_FAILED);
      }
      return result;
    } catch (error) {
      this.logger.error(`Error in cloneModule: ${error.message}`);
      throw error;
    }
  }

  /**
   * Search and filter modules with various criteria
   * @param searchDto The search criteria and filters
   * @param tenantId The tenant ID for data isolation
   * @param organisationId The organization ID for data isolation
   */
  async search(
    searchDto: SearchModuleDto,
    tenantId: string,
    organisationId: string
  ): Promise<SearchModuleResponseDto> {
    this.logger.log(`Searching modules with criteria: ${JSON.stringify(searchDto)}`);

    // Check cache first
    const cacheKey = this.cacheConfig.getModuleSearchKey(
      tenantId, 
      organisationId, 
      searchDto,
      searchDto.offset,
      searchDto.limit
    );
    
    const cachedResult = await this.cacheService.get<SearchModuleResponseDto>(cacheKey);
    if (cachedResult) {
      this.logger.log(`Cache hit for module search: ${cacheKey}`);
      return cachedResult;
    }

    // Build where clause with required filters
    const whereClause: FindOptionsWhere<Module> = { 
      tenantId,
      status: Not(ModuleStatus.ARCHIVED),
    };
    
    // Add organisation filter if provided
    if (organisationId) {
      whereClause.organisationId = organisationId;
    }

    // Add course filter if provided
    if (searchDto.courseId) {
      whereClause.courseId = searchDto.courseId;
    }

    // Add parent filter if provided
    if (searchDto.parentId) {
      whereClause.parentId = searchDto.parentId;
    } else if (searchDto.parentId === null) {
      // If parentId is explicitly set to null, search for root modules
      whereClause.parentId = IsNull();
    }

    // Add status filter if provided
    if (searchDto.status) {
      whereClause.status = searchDto.status;
    }

    // Build query builder for complex search
    const queryBuilder = this.moduleRepository.createQueryBuilder('module')
      .where(whereClause);

    // Add text search if query is provided
    if (searchDto.query) {
      queryBuilder.andWhere(
        '(module.title ILIKE :query OR module.description ILIKE :query)',
        { query: `%${searchDto.query}%` }
      );
    }

    // Get total count for pagination
    const totalElements = await queryBuilder.getCount();

    // Add pagination
    const offset = searchDto.offset || 0;
    const limit = searchDto.limit || 10;
    queryBuilder.skip(offset).take(limit);

    // Add sorting
    const sortBy = searchDto.sortBy || 'ordering';
    const orderBy = searchDto.orderBy || 'ASC';
    queryBuilder.orderBy(`module.${sortBy}`, orderBy);

    // Execute query
    const modules = await queryBuilder.getMany();

    // Fetch lesson counts for each module
    const modulesWithLessonCounts = await this.enrichModulesWithLessonCounts(
      modules,
      tenantId,
      organisationId
    );

    const result = {
      modules: modulesWithLessonCounts,
      totalElements,
      offset,
      limit
    };

    // Cache the result
    await this.cacheService.set(cacheKey, result, this.cacheConfig.MODULE_TTL);
    this.logger.log(`Cached module search result: ${cacheKey}`);

    return result;
  }

  /**
   * Enrich modules with lesson counts
   * @param modules List of modules to enrich
   * @param tenantId Tenant ID for data isolation
   * @param organisationId Organization ID for data isolation
   * @returns Modules with lesson counts
   */
  private async enrichModulesWithLessonCounts(
    modules: Module[],
    tenantId: string,
    organisationId: string
  ): Promise<any[]> {
    if (!modules.length) {
      return [];
    }

    // Get module IDs
    const moduleIds = modules.map(module => module.moduleId);

    // Fetch lesson counts for all modules in a single query (only parent lessons)
    const lessonCounts = await this.lessonRepository
      .createQueryBuilder('lesson')
      .select('lesson.moduleId', 'moduleId')
      .addSelect('COUNT(*)', 'count')
      .where('lesson.moduleId IN (:...moduleIds)', { moduleIds })
      .andWhere('lesson.tenantId = :tenantId', { tenantId })
      .andWhere('lesson.organisationId = :organisationId', { organisationId })
      .andWhere('lesson.status != :archivedStatus', { archivedStatus: LessonStatus.ARCHIVED })
      .andWhere('lesson.parentId IS NULL') // Only count parent lessons, exclude child lessons
      .groupBy('lesson.moduleId')
      .getRawMany();

    // Create a map of moduleId to lesson count
    const lessonCountMap = new Map<string, number>();
    lessonCounts.forEach(item => {
      lessonCountMap.set(item.moduleId, parseInt(item.count));
    });

    // Enrich modules with lesson counts
    return modules.map(module => ({
      ...module,
      lessonCount: lessonCountMap.get(module.moduleId) || 0
    }));
  }
}