import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  Patch,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { TrackingService } from './tracking.service';
import { API_IDS } from '../common/constants/api-ids.constant';
import { ApiId } from '../common/decorators/api-id.decorator';
import { CommonQueryDto } from '../common/dto/common-query.dto';
import { UpdateLessonTrackingDto } from './dto/update-lesson-tracking.dto';
import { UpdateCourseTrackingDto } from './dto/update-course-tracking.dto';
import { UpdateEventProgressDto } from './dto/update-event-progress.dto';
import { RecalculateProgressDto } from './dto/recalculate-progress.dto';
import { TenantOrg } from '../common/decorators/tenant-org.decorator';
import { LessonStatusDto } from './dto/lesson-status.dto';
import { LessonTrack } from './entities/lesson-track.entity';
import { UserJourneyDto, UserJourneyResponseDto } from './dto/user-journey.dto';

@ApiTags('Tracking')
@ApiBearerAuth()
@Controller('tracking')
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @Post('userjourney')
  @HttpCode(HttpStatus.OK)
  @ApiId(API_IDS.GET_USER_JOURNEY)
  @ApiOperation({
    summary: 'Get user journey by user and cohort',
    description:
      'Returns enrolled courses for the user in the given cohort with totalEventLessons and isAttendedOneEvent. progressDetail.assessmentOutcome uses assessment internal POST .../internal/attempts/user/result-status (body: userId, testId, tenantId, organisationId; no auth headers) when ASSESSMENT_SERVICE_URL is set; isImported/submitted only for tests.gradingType assessment. Override path with ASSESSMENT_USER_RESULT_PATH if needed. Deduped per testId, parallel. Uses limit/offset for pagination.',
  })
  @ApiBody({ type: UserJourneyDto })
  @ApiResponse({
    status: 200,
    description: 'User journey retrieved successfully',
    type: UserJourneyResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async getUserJourney(
    @Body() userJourneyDto: UserJourneyDto,
    @TenantOrg() tenant: { tenantId: string; organisationId: string },
  ): Promise<UserJourneyResponseDto> {
    return this.trackingService.getUserJourney(
      userJourneyDto,
      tenant.tenantId,
      tenant.organisationId,
    );
  }


  @Get('course/:courseId/:userId')
  @ApiId(API_IDS.GET_COURSE_TRACKING)
  @ApiOperation({ summary: 'Get course tracking status' })
  @ApiParam({ name: 'courseId', description: 'The course ID', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Course tracking data retrieved successfully' })
  async getCourseTracking(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @TenantOrg() tenant: {tenantId: string, organisationId: string},  
  ) {
    return this.trackingService.getCourseTracking(
      courseId, 
      userId,
      tenant.tenantId,
      tenant.organisationId
    );
  }

  @Patch('course/:courseId/:userId')
  @ApiId(API_IDS.UPDATE_COURSE_TRACKING)
  @ApiOperation({ summary: 'Update course tracking status' })
  @ApiParam({ name: 'courseId', description: 'The course ID', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'userId', description: 'The user ID', type: 'string', format: 'uuid' })
  @ApiBody({ type: UpdateCourseTrackingDto })
  @ApiResponse({ status: 200, description: 'Course tracking updated successfully' })
  @ApiResponse({ status: 404, description: 'Course tracking not found' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  async updateCourseTracking(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() updateCourseTrackingDto: UpdateCourseTrackingDto,
    @TenantOrg() tenant: {tenantId: string, organisationId: string},  
  ) {
    return this.trackingService.updateCourseTracking(
      courseId, 
      userId,
      updateCourseTrackingDto,
      tenant.tenantId,
      tenant.organisationId
    );
  }


  @Post('lesson/attempt/:lessonId')
  @ApiId(API_IDS.START_LESSON_ATTEMPT)
  @ApiOperation({ summary: 'Start a new lesson attempt or get existing incomplete attempt' })
  @ApiResponse({ status: 201, description: 'Lesson attempt started or retrieved' })
  async startLessonAttempt(
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Query() query: CommonQueryDto,
    @TenantOrg() tenant: {tenantId: string, organisationId: string},  
  ) {
    return this.trackingService.startLessonAttempt(
      lessonId,
      query.userId,
      tenant.tenantId,
      tenant.organisationId
    );
  }

  @Get('lesson/attempt/:lessonId/:userId')
  @ApiId(API_IDS.MANAGE_LESSON_ATTEMPT)
  @ApiOperation({ summary: 'Start over or resume a lesson attempt' })
  @ApiParam({ name: 'action', enum: ['start', 'resume'], description: 'Action to perform on the attempt' })
  @ApiResponse({ status: 200, description: 'Lesson attempt managed successfully' })
  async manageLessonAttempt(
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('action') action: 'start' | 'resume',
    @Query() query: CommonQueryDto,
    @TenantOrg() tenant: {tenantId: string, organisationId: string},  
  ) {
    return this.trackingService.manageLessonAttempt(
      lessonId,
      action,
      query.userId,
      tenant.tenantId,
      tenant.organisationId
    );
  }

  @Get(':lessonId/users/:userId/status')
  @ApiId(API_IDS.GET_LESSON_STATUS)
  @ApiOperation({ summary: 'Get lesson status for a user' })
  @ApiResponse({
    status: 200,
    description: 'Returns lesson status including resume and reattempt flags',
    type: LessonStatusDto
  })
  async getLessonStatus(
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @TenantOrg() tenant: {tenantId: string, organisationId: string},
  ): Promise<LessonStatusDto> {
    return this.trackingService.getLessonStatus(
      lessonId,
      userId,
      tenant.tenantId,
      tenant.organisationId
    );
  }


  @Get('attempts/:attemptId/:userId')
  @ApiId(API_IDS.GET_ATTEMPT)
  @ApiOperation({ summary: 'Get attempt details' })
  @ApiResponse({
    status: 200,
    description: 'Returns attempt details',
    type: LessonTrack
  })
  async getAttempt(
    @Param('attemptId') attemptId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @TenantOrg() tenant: {tenantId: string, organisationId: string},  
  ): Promise<LessonTrack> {
    return this.trackingService.getAttempt(
      attemptId,
      userId,
      tenant.tenantId,
      tenant.organisationId
    );
  }

  @Patch('attempts/progress/:attemptId')
  @ApiId(API_IDS.UPDATE_ATTEMPT_PROGRESS)
  @ApiOperation({ summary: 'Update attempt progress' })
  @ApiResponse({
    status: 200,
    description: 'Returns updated attempt details',
    type: LessonTrack
  })
  async updateProgress(
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Body() UpdateLessonTrackingDto: UpdateLessonTrackingDto,
    @Query() query: CommonQueryDto,
    @TenantOrg() tenant: {tenantId: string, organisationId: string},  
  ): Promise<LessonTrack> {
    return this.trackingService.updateProgress(
      attemptId,
      UpdateLessonTrackingDto,
      query.userId,
      tenant.tenantId,
      tenant.organisationId
    );
  }

  @Patch('event/:eventId')
  @ApiId(API_IDS.UPDATE_EVENT_LESSON)
  @ApiOperation({ summary: 'Update lesson completion by event ID' })
  @ApiParam({ name: 'eventId', description: 'The event ID that maps to lesson.media.source', type: 'string' })
  @ApiBody({ type: UpdateEventProgressDto })
  @ApiResponse({ status: 200, description: 'Lesson attempt marked as completed successfully' })
  @ApiResponse({ status: 404, description: 'Lesson not found for the given event ID' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  async updateEventLesson(
    @Param('eventId') eventId: string,
    @Body() updateEventProgressDto: UpdateEventProgressDto,
    @TenantOrg() tenant: {tenantId: string, organisationId: string},  
  ): Promise<LessonTrack> {
    return this.trackingService.updateEventProgress(
      eventId,
      updateEventProgressDto,
      tenant.tenantId,
      tenant.organisationId
    );
  }

  @Post('recalculate-progress')
  @ApiId(API_IDS.RECALCULATE_PROGRESS)
  @ApiOperation({ summary: 'Recalculate progress for course tracking and module tracking' })
  @ApiBody({ type: RecalculateProgressDto })
  @ApiResponse({ 
    status: 200, 
    description: 'Progress recalculated successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        courseTrackUpdated: { type: 'number' },
        moduleTrackUpdated: { type: 'number' }
      }
    }
  })
  @ApiResponse({ status: 404, description: 'Course not found' })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  async recalculateProgress(
    @Body() recalculateProgressDto: RecalculateProgressDto,
    @TenantOrg() tenant: {tenantId: string, organisationId: string},  
  ) {
    return this.trackingService.recalculateProgress(
      recalculateProgressDto.courseId,
      tenant.tenantId,
      tenant.organisationId
    );
  }
}