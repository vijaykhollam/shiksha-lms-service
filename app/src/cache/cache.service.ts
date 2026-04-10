import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { CacheConfigService } from './cache-config.service';
import { Course } from '../courses/entities/course.entity';
import { Module } from '../modules/entities/module.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { UserEnrollment } from '../enrollments/entities/user-enrollment.entity';
import { ConfigService } from '@nestjs/config';
import { TenantConfigValue } from '../configuration/interfaces/tenant-config.interface';

/**
 * Course metadata interface for caching
 * Contains only cacheable metadata fields, not full course entity
 */
export interface CourseMetadata {
  courseId: string;
  tenantId: string;
  organisationId: string;
  title: string;
  alias: string;
  shortDescription?: string;
  description: string;
  image?: string;
  featured: boolean;
  free: boolean;
  status: string;
  params?: Record<string, any>;
  ordering: number;
  prerequisites?: string[];
  certificateTerm?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Static lesson hierarchy interface for caching
 * Contains ONLY static/shared lesson structure - NO user-specific tracking data
 * 
 * Why this structure is cached:
 * - Lesson metadata (title, ordering, content references) is identical for all users
 * - This data rarely changes and can be safely cached
 * 
 * Why tracking is NOT cached:
 * - Tracking data (progress, status, timeSpent) is user-specific and changes frequently
 * - Each user has different progress, so caching would return wrong data
 */
export interface StaticLessonHierarchy {
  lessonId: string;
  parentId?: string;
  tenantId?: string;
  organisationId?: string;
  title: string;
  alias?: string;
  status: string;
  description?: string;
  image?: string;
  startDatetime?: Date;
  endDatetime?: Date;
  storage?: string;
  noOfAttempts?: number;
  attemptsGrade?: string;
  allowResubmission?: boolean;
  format: string;
  subFormat?: string;
  mediaId?: string;
  media?: any; // Media relation object (static)
  prerequisites?: string[];
  idealTime?: number;
  resume?: boolean;
  totalMarks?: number;
  passingMarks?: number;
  params?: Record<string, any>;
  courseId?: string;
  moduleId?: string;
  sampleLesson?: boolean;
  considerForPassing?: boolean;
  ordering: number;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string;
  updatedBy?: string;
  // Associated lessons structure (static only, no tracking)
  associatedLesson?: StaticLessonHierarchy[];
  // Associated files structure (static only)
  associatedFiles?: Array<{
    associatedFileId: string;
    mediaId?: string;
    media?: any;
    [key: string]: any;
  }>;
}

/**
 * Static module hierarchy interface for caching
 * Contains ONLY static/shared module structure - NO user-specific tracking data
 * 
 * Why this structure is cached:
 * - Module metadata (title, description, ordering, dates) is identical for all users
 * - This data rarely changes and can be safely cached
 * 
 * Why tracking is NOT cached:
 * - Tracking data (progress, completedLessons) is user-specific and changes frequently
 * - Each user has different progress, so caching would return wrong data
 */
export interface StaticModuleHierarchy {
  moduleId: string;
  parentId?: string;
  courseId?: string;
  tenantId?: string;
  organisationId?: string;
  title: string;
  description?: string;
  image?: string;
  startDatetime?: Date;
  endDatetime?: Date;
  prerequisites?: string[];
  badgeTerm?: Record<string, any>;
  badgeId?: string;
  ordering: number;
  status: string;
  createdAt?: Date;
  createdBy?: string;
  updatedAt?: Date;
  updatedBy?: string;
  // Lessons structure (static only, no tracking)
  lessons?: StaticLessonHierarchy[];
}

/**
 * Static course hierarchy interface for caching
 * Contains ONLY static/shared course structure - NO user-specific tracking or eligibility data
 * 
 * Why this structure is cached:
 * - Course hierarchy (course + modules + lessons structure) is identical for all users
 * - This static structure rarely changes and can be safely cached
 * - Caching reduces database load for frequently accessed course structures
 * 
 * Why tracking and eligibility are NOT cached:
 * - Tracking data (progress, status, timeSpent, completedLessons) is user-specific
 * - Eligibility checks depend on user's completion status of prerequisite courses
 * - Each user has different tracking and eligibility, so caching would return wrong data
 */
export interface CourseHierarchy {
  // Course static metadata
  courseId: string;
  tenantId: string;
  organisationId: string;
  title: string;
  alias: string;
  shortDescription?: string;
  description: string;
  image?: string;
  featured: boolean;
  free: boolean;
  status: string;
  params?: Record<string, any>;
  ordering: number;
  prerequisites?: string[];
  certificateTerm?: Record<string, any>;
  // Module hierarchy (static only, no tracking)
  modules?: StaticModuleHierarchy[];
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly cacheEnabled: boolean;
  // LMS-specific cache enable flag - controls caching for LMS service operations
  // When false, Redis is completely bypassed for LMS operations to avoid any overhead
  private readonly lmsCacheEnabled: boolean;

  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly configService: ConfigService,
    private readonly cacheConfig: CacheConfigService
  ) {
    this.cacheEnabled = this.configService.get('CACHE_ENABLED') === 'true';
    // LMS_CACHE_ENABLED is the global flag that controls LMS-specific caching
    // This allows fine-grained control over caching behavior in the LMS service
    this.lmsCacheEnabled = this.configService.get('LMS_CACHE_ENABLED') === 'true';
  }

  /**
   * Get value from cache
   * @param key Cache key
   * @returns Cached value or null if not found
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.cacheEnabled) {
      this.logger.debug(`Cache is ${!this.cacheEnabled ? 'disabled' : 'not connected'}, skipping get for key ${key}`);
      return null;
    }

    try {
      this.logger.debug(`Attempting to get cache for key ${key}`);
      const value = await this.cacheManager.get<T>(key);
      if (value !== undefined && value !== null) {
        this.logger.debug(`Cache HIT for key ${key}`);
        return value;
      } else {
        this.logger.debug(`Cache MISS for key ${key}`);
        return null;
      }
      return value || null;
    } catch (error) {
      this.logger.error(`Error getting cache for key ${key}: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Set value in cache
   * @param key Cache key
   * @param value Value to cache
   * @param ttl Time to live in seconds
   */
  async set(key: string, value: any, ttl: number): Promise<void> {
    if (!this.cacheEnabled) {
      this.logger.debug(`Cache is ${!this.cacheEnabled ? 'disabled' : 'not connected'}, skipping set for key ${key}`);
      return;
    }

    try {
      this.logger.debug(`Attempting to set cache for key ${key} with TTL ${ttl}s`);
      await this.cacheManager.set(key, value, ttl * 1000); // Convert to milliseconds
      this.logger.debug(`Successfully set cache for key ${key}`);
    } catch (error) {
      this.logger.error(`Error setting cache for key ${key}: ${error.message}`, error.stack);
    }
  }

  /**
   * Delete value from cache
   * @param key Cache key
   */
  async del(key: string): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }

    try {
      // this.logger.debug(`Deleting cache for key ${key}`);
      await this.cacheManager.del(key);
    } catch (error) {
      this.logger.error(`Error deleting cache for key ${key}: ${error.message}`);
    }
  }

  /**
   * Delete multiple values from cache using pattern
   * @param pattern Cache key pattern (supports :* wildcard at the end)
   */
  async delByPattern(pattern: string): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }

    try {
      // Get all keys from the cache store
      const store = (this.cacheManager as any).store;
      if (!store || typeof store.keys !== 'function') {
        return;
      }

      const keys = await store.keys();

      // Convert pattern to regex if it ends with :*
      const patternRegex = pattern.endsWith(':*') 
        ? new RegExp(`^${pattern.slice(0, -2)}:.*$`)
        : new RegExp(`^${pattern}$`);

      const matchingKeys = keys.filter(key => patternRegex.test(key));
      
      if (matchingKeys.length > 0) {
        this.logger.debug(`Found ${matchingKeys.length} keys matching pattern ${pattern}`);
        await Promise.all(matchingKeys.map(key => this.del(key)));
      } else {
      }
    } catch (error) {
    }
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }

    try {
      const store = (this.cacheManager as any).store;
      if (!store || typeof store.reset !== 'function') {
        this.logger.warn('Cache store does not support reset');
        return;
      }
      await store.reset();
    } catch (error) {
      this.logger.error(`Error clearing cache: ${error.message}`);
    }
  }

  // Configuration-specific cache methods
  async getTenantConfig(tenantId: string): Promise<TenantConfigValue | null> {  
    const key = this.cacheConfig.getTenantConfigKey(tenantId);
    const value = await this.cacheManager.get<any>(key);
    if (value !== undefined && value !== null) {
      this.logger.debug(`Cache HIT for key ${key}`);
      return value;
    } else {
      this.logger.debug(`Cache MISS for key ${key}`);
      return null;
    }
  }

  async setTenantConfig(tenantId: string, config: TenantConfigValue): Promise<void> {
   
    const key = this.cacheConfig.getTenantConfigKey(tenantId);
    await this.cacheManager.set(key, config, 0);  
  
  }

  async deleteTenantConfig(tenantId: string): Promise<void> {
   
    const key = this.cacheConfig.getTenantConfigKey(tenantId);
    await this.cacheManager.del(key); 
  
  }
  // Course-specific cache methods
  async getCourse(courseId: string, tenantId: string, organisationId: string): Promise<Course | null> {
    if (!this.cacheEnabled) {
      return null;
    }
    return this.get<Course>(this.cacheConfig.getCourseKey(courseId, tenantId, organisationId));
  }

  async setCourse(course: Course): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    await this.set(
      this.cacheConfig.getCourseKey(course.courseId, course.tenantId, course.organisationId),
      course,
      this.cacheConfig.COURSE_TTL
    );
  }

  async getCourseEventLessons(courseId: string): Promise<string[] | null> {
    if (!this.cacheEnabled) {
      return null;
    }
    return this.get<string[]>(this.cacheConfig.getCourseEventLessonsKey(courseId));
  }

  async setCourseEventLessons(courseId: string, lessonIds: string[]): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    await this.set(
      this.cacheConfig.getCourseEventLessonsKey(courseId),
      lessonIds,
      this.cacheConfig.COURSE_TTL
    );
  }

  async invalidateCourse(courseId: string, tenantId: string, organisationId: string): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    // Invalidate course-specific caches
    await Promise.all([
      this.del(this.cacheConfig.getCourseKey(courseId, tenantId, organisationId)),
      this.del(this.cacheConfig.getCourseHierarchyKey(courseId, tenantId, organisationId)),
      this.delByPattern(this.cacheConfig.getCourseModulesPattern(courseId, tenantId, organisationId)),
      this.delByPattern(`${this.cacheConfig.COURSE_PREFIX}search:${tenantId}:${organisationId}:*`),
      this.del(this.cacheConfig.getCourseEventLessonsKey(courseId)),
    ]);

    // Invalidate course metadata cache (LMS-specific cache)
    await this.invalidateCourseMetaCache(courseId);

    // Invalidate course hierarchy cache (LMS-specific cache)
    await this.invalidateCourseHierarchyCache(courseId);

    // Invalidate related module caches
    await this.invalidateCourseModules(courseId, tenantId, organisationId);

    // Invalidate related lesson caches
    await this.invalidateCourseLessons(courseId, tenantId, organisationId);

    // Invalidate related enrollment caches
    await this.invalidateCourseEnrollments(courseId, tenantId, organisationId);

    // Invalidate module search caches since they might filter by courseId
    await this.invalidateModuleSearchCaches(tenantId, organisationId);
  }

  /**
   * Invalidate course hierarchy cache
   * 
   * Invalidates both the base course hierarchy cache and all module-specific variants.
   * This should be called whenever course structure (modules/lessons) is updated.
   * 
   * IMPORTANT: This method uses LMS_CACHE_ENABLED flag, NOT CACHE_ENABLED.
   * This allows LMS-specific caching to work independently of the old cache system.
   * 
   * @param courseId Course ID to invalidate hierarchy cache for
   */
  async invalidateCourseHierarchyCache(courseId: string): Promise<void> {
    // When LMS_CACHE_ENABLED is false, skip Redis operations entirely
    if (!this.lmsCacheEnabled) {
      return;
    }

    try {
      // Invalidate base course hierarchy cache (without module)
      const baseCacheKey = `course:hierarchy:${courseId}`;
      await this.cacheManager.del(baseCacheKey);
      this.logger.debug(`Invalidated course hierarchy cache for key ${baseCacheKey}`);

      // Invalidate all module-specific course hierarchy caches
      // Pattern: course:hierarchy:${courseId}:module:*
      // Get all keys from the cache store to match the pattern
      const store = (this.cacheManager as any).store;
      if (store && typeof store.keys === 'function') {
        const keys = await store.keys();
        const patternRegex = new RegExp(`^course:hierarchy:${courseId}:module:.*$`);
        const matchingKeys = keys.filter((key: string) => patternRegex.test(key));
        
        if (matchingKeys.length > 0) {
          this.logger.debug(`Found ${matchingKeys.length} module-specific course hierarchy cache keys to invalidate`);
          await Promise.all(matchingKeys.map((key: string) => this.cacheManager.del(key)));
        }
      }

      // Invalidate aggregate-content caches so POST /course/aggregate-content serves fresh structure
      await this.invalidateAggregateContentCache();
    } catch (error) {
      // Log cache invalidation failure but don't break the request
      this.logger.warn(`Failed to invalidate course hierarchy cache for courseId ${courseId}: ${error.message}`);
    }
  }

  async invalidateCourseModules(courseId: string, tenantId: string, organisationId: string): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    await this.delByPattern(this.cacheConfig.getCourseModulesPattern(courseId, tenantId, organisationId));
  }

  async invalidateCourseLessons(courseId: string, tenantId: string, organisationId: string): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    await this.delByPattern(`${this.cacheConfig.LESSON_PREFIX}course:${courseId}:${tenantId}:${organisationId}:*`);
  }

  async invalidateCourseEnrollments(courseId: string, tenantId: string, organisationId: string): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    await this.delByPattern(`${this.cacheConfig.ENROLLMENT_PREFIX}*:${courseId}:${tenantId}:${organisationId}:*`);
  }

  // Module-specific cache methods
  async getModule(moduleId: string, tenantId: string, organisationId: string): Promise<Module | null> {
    if (!this.cacheEnabled) {
      return null;
    }
    return this.get<Module>(this.cacheConfig.getModuleKey(moduleId, tenantId, organisationId));
  }

  async setModule(module: Module): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    await this.set(
      this.cacheConfig.getModuleKey(module.moduleId, module.tenantId, module.organisationId),
      module,
      this.cacheConfig.MODULE_TTL
    );
  }

  async invalidateModule(moduleId: string, courseId: string, tenantId: string, organisationId: string): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    // Invalidate module-specific caches
    await Promise.all([
      this.del(this.cacheConfig.getModuleKey(moduleId, tenantId, organisationId)),
      this.del(this.cacheConfig.getModuleHierarchyKey(moduleId, tenantId, organisationId)),
      this.delByPattern(this.cacheConfig.getModuleLessonsPattern(moduleId, tenantId, organisationId)),
    ]);

    // Invalidate module search caches for this tenant/organization
    await this.invalidateModuleSearchCaches(tenantId, organisationId);

    // Invalidate parent course caches
    await this.invalidateCourse(courseId, tenantId, organisationId);
  }

  /**
   * Invalidate all module search caches for a specific tenant/organization
   */
  private async invalidateModuleSearchCaches(tenantId: string, organisationId: string): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    // Invalidate all module search caches for this tenant/organization
    const searchPattern = `${this.cacheConfig.MODULE_PREFIX}search:${tenantId}:${organisationId}:*`;
    await this.delByPattern(searchPattern);
  }

  // Lesson-specific cache methods
  async getLesson(lessonId: string, tenantId: string, organisationId: string): Promise<Lesson | null> {
    if (!this.cacheEnabled) {
      return null;
    }
    return this.get<Lesson>(this.cacheConfig.getLessonKey(lessonId, tenantId, organisationId));
  }

  async setLesson(lesson: Lesson): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    await this.set(
      this.cacheConfig.getLessonKey(lesson.lessonId, lesson.tenantId, lesson.organisationId),
      lesson,
      this.cacheConfig.LESSON_TTL
    );
  }

  async invalidateLesson(lessonId: string, moduleId: string, courseId: string, tenantId: string, organisationId: string): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    // Invalidate lesson-specific caches
    await Promise.all([
      this.del(this.cacheConfig.getLessonKey(lessonId, tenantId, organisationId)),
      this.invalidateCourse(courseId, tenantId, organisationId),
      this.invalidateModule(moduleId, courseId, tenantId, organisationId),
    ]);
  }

  // Enrollment-specific cache methods
  async getEnrollment(userId: string, courseId: string, tenantId: string, organisationId: string): Promise<UserEnrollment | null> {
    if (!this.cacheEnabled) {
      return null;
    }
    return this.get<UserEnrollment>(
      this.cacheConfig.getEnrollmentKey(userId, courseId, tenantId, organisationId)
    );
  }

  async setEnrollment(enrollment: UserEnrollment): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    await this.set(
      this.cacheConfig.getEnrollmentKey(enrollment.userId, enrollment.courseId, enrollment.tenantId, enrollment.organisationId),
      enrollment,
      this.cacheConfig.ENROLLMENT_TTL
    );
  }

  async invalidateEnrollment(userId: string, courseId: string, tenantId: string, organisationId: string): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    // Invalidate enrollment-specific caches
    await Promise.all([
      this.delByPattern(`${this.cacheConfig.ENROLLMENT_PREFIX}list:${tenantId}:${organisationId}:*`),
      this.del(this.cacheConfig.getEnrollmentKey(userId, courseId, tenantId, organisationId)),
      this.delByPattern(this.cacheConfig.getEnrollmentPattern(tenantId, organisationId)),
    ]);
  }

  /**
   * Get cached course metadata
   * 
   * This method caches ONLY course metadata (title, description, image, status, ordering, 
   * prerequisites, certificateTerm) - NOT the full course entity or user-specific data.
   * 
   * Why only course metadata is cached:
   * - Course metadata is shared across users and rarely changes
   * - User-specific data (enrollments, progress) must always be fresh from DB
   * - Full course entities may contain relations that shouldn't be cached
   * 
   * IMPORTANT: This method uses LMS_CACHE_ENABLED flag, NOT CACHE_ENABLED.
   * This allows LMS-specific caching to work independently of the old cache system.
   * 
   * @param courseId Course ID
   * @param cohortId Optional cohort ID if course metadata varies per cohort
   * @returns Cached course metadata or null if not found/caching disabled
   */
  async getCourseMetaCached(courseId: string, cohortId?: string): Promise<CourseMetadata | null> {
    // When LMS_CACHE_ENABLED is false, bypass Redis completely to avoid any overhead
    // This ensures zero performance impact when caching is disabled
    if (!this.lmsCacheEnabled) {
      return null;
    }

    const cacheKey = cohortId 
      ? `course:meta:${courseId}:cohort:${cohortId}`
      : `course:meta:${courseId}`;
    
    // Use cacheManager directly to bypass cacheEnabled check
    // This allows LMS caching to work independently of CACHE_ENABLED flag
    try {
      this.logger.debug(`Attempting to get LMS cache for key ${cacheKey}`);
      const value = await this.cacheManager.get<CourseMetadata>(cacheKey);
      if (value !== undefined && value !== null) {
        this.logger.debug(`LMS Cache HIT for key ${cacheKey}`);
        return value;
      } else {
        this.logger.debug(`LMS Cache MISS for key ${cacheKey}`);
        return null;
      }
    } catch (error) {
      this.logger.error(`Error getting LMS cache for key ${cacheKey}: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Set cached course metadata
   * 
   * Stores only course metadata fields, not the full course entity.
   * TTL is configurable via LMS_COURSE_CACHE_TTL_SECONDS (default: 1800 seconds / 30 minutes).
   * 
   * IMPORTANT: This method uses LMS_CACHE_ENABLED flag, NOT CACHE_ENABLED.
   * This allows LMS-specific caching to work independently of the old cache system.
   * 
   * @param courseId Course ID
   * @param courseMeta Course metadata object (title, description, image, status, ordering, prerequisites, certificateTerm)
   * @param cohortId Optional cohort ID if course metadata varies per cohort
   */
  async setCourseMetaCached(courseId: string, courseMeta: CourseMetadata, cohortId?: string): Promise<void> {
    // When LMS_CACHE_ENABLED is false, skip Redis operations entirely
    if (!this.lmsCacheEnabled) {
      return;
    }

    const cacheKey = cohortId 
      ? `course:meta:${courseId}:cohort:${cohortId}`
      : `course:meta:${courseId}`;
    
    // Get TTL from environment variable, default to 1800 seconds (30 minutes)
    // This allows operators to adjust cache freshness based on business needs
    const ttl = Number.parseInt(
      this.configService.get('LMS_COURSE_CACHE_TTL_SECONDS') || '1800',
      10
    );

    // Use cacheManager directly to bypass cacheEnabled check
    // This allows LMS caching to work independently of CACHE_ENABLED flag
    // Cache writes are best-effort - errors won't break the request
    try {
      this.logger.debug(`Attempting to set LMS cache for key ${cacheKey} with TTL ${ttl}s`);
      await this.cacheManager.set(cacheKey, courseMeta, ttl * 1000); // Convert to milliseconds
      this.logger.debug(`Successfully set LMS cache for key ${cacheKey}`);
    } catch (error) {
      // Log cache write failure but don't break the request
      // Cache is an optimization - API should work even if Redis is down
      this.logger.warn(`Failed to cache course metadata for key ${cacheKey}: ${error.message}`);
    }
  }

  /**
   * Invalidate course metadata cache
   * 
   * Invalidates both the base course metadata cache and all cohort-specific variants.
   * This should be called whenever course details are updated to ensure fresh data.
   * 
   * IMPORTANT: This method uses LMS_CACHE_ENABLED flag, NOT CACHE_ENABLED.
   * This allows LMS-specific caching to work independently of the old cache system.
   * 
   * @param courseId Course ID to invalidate metadata cache for
   */
  async invalidateCourseMetaCache(courseId: string): Promise<void> {
    // When LMS_CACHE_ENABLED is false, skip Redis operations entirely
    if (!this.lmsCacheEnabled) {
      return;
    }

    try {
      // Invalidate base course metadata cache (without cohort)
      const baseCacheKey = `course:meta:${courseId}`;
      await this.cacheManager.del(baseCacheKey);
      this.logger.debug(`Invalidated course metadata cache for key ${baseCacheKey}`);

      // Invalidate all cohort-specific course metadata caches
      // Pattern: course:meta:${courseId}:cohort:*
      // Get all keys from the cache store to match the pattern
      const store = (this.cacheManager as any).store;
      if (store && typeof store.keys === 'function') {
        const keys = await store.keys();
        const patternRegex = new RegExp(`^course:meta:${courseId}:cohort:.*$`);
        const matchingKeys = keys.filter((key: string) => patternRegex.test(key));
        
        if (matchingKeys.length > 0) {
          this.logger.debug(`Found ${matchingKeys.length} cohort-specific course metadata cache keys to invalidate`);
          await Promise.all(matchingKeys.map((key: string) => this.cacheManager.del(key)));
        }
      }
    } catch (error) {
      // Log cache invalidation failure but don't break the request
      this.logger.warn(`Failed to invalidate course metadata cache for courseId ${courseId}: ${error.message}`);
    }
  }

  /**
   * Get cached course hierarchy (static structure only)
   * 
   * This method caches ONLY the static course hierarchy (course + modules + lessons structure).
   * It does NOT cache user-specific tracking data, which must always be fetched fresh from the database.
   * 
   * Why hierarchy is cached:
   * - Course structure (modules, lessons) is identical for all users
   * - This static data rarely changes and can be safely cached
   * - Caching reduces database load for frequently accessed course structures
   * 
   * Why tracking is NOT cached:
   * - Tracking data (progress, status, timeSpent, completedLessons) is user-specific
   * - Each user has different progress, so caching would return wrong data
   * - Tracking data changes frequently as users progress through the course
   * 
   * IMPORTANT: This method uses LMS_CACHE_ENABLED flag, NOT CACHE_ENABLED.
   * When LMS_CACHE_ENABLED=false, Redis is completely bypassed to avoid any overhead.
   * This ensures zero performance impact when caching is disabled.
   * 
   * Cache key format:
   * - course:hierarchy:{courseId} (if hierarchy is same for all modules)
   * - course:hierarchy:{courseId}:module:{moduleId} (if hierarchy is filtered by module)
   * 
   * @param courseId Course ID
   * @param moduleId Optional module ID if course hierarchy is filtered by module
   * @returns Cached course hierarchy or null if not found/caching disabled
   */
  async getCourseHierarchyCached(courseId: string, moduleId?: string): Promise<CourseHierarchy | null> {
    // When LMS_CACHE_ENABLED is false, bypass Redis completely to avoid any overhead
    // This ensures zero performance impact when caching is disabled
    if (!this.lmsCacheEnabled) {
      this.logger.debug(`LMS caching is disabled, skipping hierarchy cache lookup for courseId ${courseId}`);
      return null;
    }

    const cacheKey = moduleId 
      ? `course:hierarchy:${courseId}:module:${moduleId}`
      : `course:hierarchy:${courseId}`;
    
    // Use cacheManager directly to bypass cacheEnabled check
    // This allows LMS caching to work independently of CACHE_ENABLED flag
    try {
      this.logger.debug(`Attempting to get LMS hierarchy cache for key ${cacheKey}`);
      const value = await this.cacheManager.get<CourseHierarchy>(cacheKey);
      if (value !== undefined && value !== null) {
        this.logger.debug(`LMS Hierarchy Cache HIT for key ${cacheKey}`);
        return value;
      } else {
        this.logger.debug(`LMS Hierarchy Cache MISS for key ${cacheKey}`);
        return null;
      }
    } catch (error) {
      this.logger.error(`Error getting LMS hierarchy cache for key ${cacheKey}: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Set cached course hierarchy (static structure only)
   * 
   * Stores ONLY the static course hierarchy (course + modules + lessons structure).
   * Does NOT store user-specific tracking data, which must never be cached.
   * 
   * Why hierarchy is cached:
   * - Course structure (modules, lessons) is identical for all users
   * - This static data rarely changes and can be safely cached
   * - Caching reduces database load for frequently accessed course structures
   * 
   * Why tracking is NOT cached:
   * - Tracking data (progress, status, timeSpent, completedLessons) is user-specific
   * - Each user has different progress, so caching would return wrong data
   * - Tracking data changes frequently as users progress through the course
   * 
   * IMPORTANT: This method uses LMS_CACHE_ENABLED flag, NOT CACHE_ENABLED.
   * When LMS_CACHE_ENABLED=false, Redis operations are completely skipped.
   * 
   * TTL is configurable via LMS_COURSE_HIERARCHY_TTL_SECONDS (default: 1800 seconds / 30 minutes).
   * This allows operators to adjust cache freshness based on business needs.
   * 
   * Cache key format:
   * - course:hierarchy:{courseId} (if hierarchy is same for all modules)
   * - course:hierarchy:{courseId}:module:{moduleId} (if hierarchy is filtered by module)
   * 
   * @param courseId Course ID
   * @param hierarchy Static course hierarchy object (course + modules + lessons structure, NO tracking)
   * @param moduleId Optional module ID if course hierarchy is filtered by module
   */
  async setCourseHierarchyCached(courseId: string, hierarchy: CourseHierarchy, moduleId?: string): Promise<void> {
    // When LMS_CACHE_ENABLED is false, skip Redis operations entirely
    if (!this.lmsCacheEnabled) {
      this.logger.debug(`LMS caching is disabled, skipping hierarchy cache write for courseId ${courseId}`);
      return;
    }

    const cacheKey = moduleId 
      ? `course:hierarchy:${courseId}:module:${moduleId}`
      : `course:hierarchy:${courseId}`;
    
    // Get TTL from environment variable, default to 1800 seconds (30 minutes)
    // This allows operators to adjust cache freshness based on business needs
    const ttl = Number.parseInt(
      this.configService.get('LMS_COURSE_HIERARCHY_TTL_SECONDS') || '1800',
      10
    );

    // Use cacheManager directly to bypass cacheEnabled check
    // This allows LMS caching to work independently of CACHE_ENABLED flag
    // Cache writes are best-effort - errors won't break the request
    try {
      this.logger.debug(`Attempting to set LMS hierarchy cache for key ${cacheKey} with TTL ${ttl}s`);
      await this.cacheManager.set(cacheKey, hierarchy, ttl * 1000); // Convert to milliseconds
      this.logger.debug(`Successfully set LMS hierarchy cache for key ${cacheKey}`);
    } catch (error) {
      // Log cache write failure but don't break the request
      // Cache is an optimization - API should work even if Redis is down
      this.logger.warn(`Failed to cache course hierarchy for key ${cacheKey}: ${error.message}`);
    }
  }

  /**
   * Get cached lesson detail
   * 
   * This method caches lesson detail data which is globally shared across users.
   * The cache key format is: lms:lesson:{lessonId}
   * 
   * IMPORTANT: This method uses ENABLE_LMS_CACHE flag, NOT CACHE_ENABLED or LMS_CACHE_ENABLED.
   * When ENABLE_LMS_CACHE=false, Redis is completely bypassed to avoid any overhead.
   * This ensures zero performance impact when caching is disabled.
   * 
   * Cache key format:
   * - lms:lesson:{lessonId} (no tenantId or organisationId as lesson data is globally shared)
   * 
   * @param lessonId Lesson ID
   * @returns Cached lesson detail or null if not found/caching disabled
   */
  async getLessonDetailCached(lessonId: string): Promise<Lesson | null> {
    // Check LMS_CACHE_ENABLED flag - when false, bypass Redis completely
    if (!this.lmsCacheEnabled) {
      this.logger.debug(`LMS lesson caching is disabled (LMS_CACHE_ENABLED=false), skipping cache lookup for lessonId ${lessonId}`);
      return null;
    }

    const cacheKey = `lms:lesson:${lessonId}`;
    
    // Use cacheManager directly to bypass cacheEnabled check
    // This allows LMS lesson caching to work independently of CACHE_ENABLED flag
    try {
      this.logger.debug(`Attempting to get LMS lesson cache for key ${cacheKey}`);
      const value = await this.cacheManager.get<Lesson>(cacheKey);
      if (value !== undefined && value !== null) {
        this.logger.log(`Cache HIT for lesson ${lessonId}`);
        return value;
      } else {
        this.logger.log(`Cache MISS for lesson ${lessonId}`);
        return null;
      }
    } catch (error) {
      // Fail open - log error but don't break the request
      // On Redis failure, fall back to DB silently
      this.logger.error(`Error getting LMS lesson cache for key ${cacheKey}: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Set cached lesson detail
   * 
   * Stores lesson detail data which is globally shared across users.
   * TTL is configurable via LMS_LESSON_CACHE_TTL_SECONDS (default: 300 seconds / 5 minutes).
   * 
   * IMPORTANT: This method uses LMS_CACHE_ENABLED flag.
   * When LMS_CACHE_ENABLED=false, Redis operations are completely skipped.
   * 
   * Cache key format:
   * - lms:lesson:{lessonId} (no tenantId or organisationId as lesson data is globally shared)
   * 
   * @param lessonId Lesson ID
   * @param lesson Lesson entity to cache
   */
  async setLessonDetailCached(lessonId: string, lesson: Lesson): Promise<void> {
    // Check LMS_CACHE_ENABLED flag - when false, skip Redis operations entirely
    if (!this.lmsCacheEnabled) {
      this.logger.debug(`LMS lesson caching is disabled (LMS_CACHE_ENABLED=false), skipping cache write for lessonId ${lessonId}`);
      return;
    }

    const cacheKey = `lms:lesson:${lessonId}`;
    
    // Configurable TTL (default: 300 seconds / 5 minutes)
    const ttl = Number(this.configService.get('LMS_LESSON_CACHE_TTL_SECONDS') || '300');

    // Use cacheManager directly to bypass cacheEnabled check
    // This allows LMS lesson caching to work independently of CACHE_ENABLED flag
    // Cache writes are best-effort - errors won't break the request
    // On Redis failure, fall back to DB silently
    try {
      this.logger.debug(`Attempting to set LMS lesson cache for key ${cacheKey} with TTL ${ttl}s`);
      await this.cacheManager.set(cacheKey, lesson, ttl * 1000); // Convert to milliseconds
      this.logger.debug(`Successfully set LMS lesson cache for key ${cacheKey}`);
    } catch (error) {
      // Log cache write failure but don't break the request
      // Cache is an optimization - API should work even if Redis is down
      this.logger.warn(`Failed to cache lesson detail for key ${cacheKey}: ${error.message}`);
    }
  }

  /**
   * Invalidate cached lesson detail
   * 
   * Removes the cached lesson detail when lesson is updated or deleted.
   * This ensures stale data is not served from cache.
   * 
   * IMPORTANT: This method uses LMS_CACHE_ENABLED flag.
   * When LMS_CACHE_ENABLED=false, Redis operations are completely skipped.
   * 
   * Cache key format:
   * - lms:lesson:{lessonId} (no tenantId or organisationId as lesson data is globally shared)
   * 
   * @param lessonId Lesson ID to invalidate
   */
  async invalidateLessonDetailCached(lessonId: string): Promise<void> {
    // Check LMS_CACHE_ENABLED flag - when false, skip Redis operations entirely
    if (!this.lmsCacheEnabled) {
      this.logger.debug(`LMS lesson caching is disabled (LMS_CACHE_ENABLED=false), skipping cache invalidation for lessonId ${lessonId}`);
      return;
    }

    const cacheKey = `lms:lesson:${lessonId}`;

    // Use cacheManager directly to bypass cacheEnabled check
    // This allows LMS lesson caching to work independently of CACHE_ENABLED flag
    // Cache invalidation is best-effort - errors won't break the request
    try {
      this.logger.debug(`Attempting to invalidate LMS lesson cache for key ${cacheKey}`);
      await this.cacheManager.del(cacheKey);
      this.logger.debug(`Successfully invalidated LMS lesson cache for key ${cacheKey}`);
    } catch (error) {
      // Log cache invalidation failure but don't break the request
      // Cache is an optimization - API should work even if Redis is down
      this.logger.warn(`Failed to invalidate lesson detail cache for key ${cacheKey}: ${error.message}`);
    }
  }

  /**
   * Get cached aggregate content (static structure only, NO tracking)
   *
   * Caches ONLY the static course/module/lesson structure for the aggregate-content API.
   * Tracking data is never cached and must be fetched and merged on each request.
   *
   * Cache key format: course:aggregate:{pathwayId|cohortId}:{tenantId}:{organisationId}:{contentType}
   *
   * @param cacheKey Full cache key
   * @returns Cached static courses array or null
   */
  async getAggregateContentCached(cacheKey: string): Promise<{ courses: any[] } | null> {
    if (!this.lmsCacheEnabled) {
      this.logger.log(`[aggregate-content] LMS caching is disabled (LMS_CACHE_ENABLED), skipping cache lookup for key ${cacheKey}`);
      return null;
    }
    try {
      this.logger.debug(`Attempting to get aggregate-content cache for key ${cacheKey}`);
      const value = await this.cacheManager.get<{ courses: any[] }>(cacheKey);
      if (value !== undefined && value !== null) {
        this.logger.log(`[aggregate-content] Cache HIT for key ${cacheKey}`);
        return value;
      }
      this.logger.log(`[aggregate-content] Cache MISS for key ${cacheKey}`);
      return null;
    } catch (error) {
      this.logger.error(`Error getting aggregate-content cache for key ${cacheKey}: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Set cached aggregate content (static structure only, NO tracking)
   *
   * TTL: LMS_COURSE_CACHE_TTL_SECONDS (default 1800 seconds).
   *
   * @param cacheKey Full cache key
   * @param staticCourses Object with { courses } - structure only, no tracking
   */
  async setAggregateContentCached(cacheKey: string, staticCourses: { courses: any[] }): Promise<void> {
    if (!this.lmsCacheEnabled) {
      this.logger.log(`[aggregate-content] LMS caching is disabled (LMS_CACHE_ENABLED), skipping cache write for key ${cacheKey}`);
      return;
    }
    const ttl = Number.parseInt(
      this.configService.get('LMS_COURSE_CACHE_TTL_SECONDS') || '1800',
      10
    );
    try {
      this.logger.debug(`Attempting to set aggregate-content cache for key ${cacheKey} with TTL ${ttl}s`);
      await this.cacheManager.set(cacheKey, staticCourses, ttl * 1000);
      this.logger.log(`[aggregate-content] Cache SET for key ${cacheKey} (TTL ${ttl}s)`);
    } catch (error) {
      this.logger.warn(`Failed to set aggregate-content cache for key ${cacheKey}: ${error.message}`);
    }
  }

  /**
   * Invalidate all aggregate-content caches.
   * Call when any course, module, or lesson is created/updated so aggregate API serves fresh structure.
   */
  async invalidateAggregateContentCache(): Promise<void> {
    if (!this.lmsCacheEnabled) {
      this.logger.debug(`LMS caching is disabled, skipping aggregate-content cache invalidation`);
      return;
    }
    try {
      const store = (this.cacheManager as any).store;
      if (!store || typeof store.keys !== 'function') {
        return;
      }
      const keys = await store.keys();
      const patternRegex = /^course:aggregate:.*$/;
      const matchingKeys = keys.filter((key: string) => patternRegex.test(key));
      if (matchingKeys.length > 0) {
        this.logger.debug(`Invalidating ${matchingKeys.length} aggregate-content cache key(s)`);
        await Promise.all(matchingKeys.map((key: string) => this.cacheManager.del(key)));
      }
    } catch (error) {
      this.logger.warn(`Failed to invalidate aggregate-content cache: ${error.message}`);
    }
  }
} 