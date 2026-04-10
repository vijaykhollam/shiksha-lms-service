import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UserJourneyDto {
  @ApiProperty({ description: 'User ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsNotEmpty()
  @IsString()
  userId: string;

  @ApiPropertyOptional({ description: 'Cohort ID (stored in course.params.cohortId)', example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsOptional()
  @IsString()
  cohortId?: string;

  @ApiPropertyOptional({ description: 'Pathway ID (stored in course.params.pathwayId)', example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsOptional()
  @IsString()
  pathwayId?: string;

  @ApiPropertyOptional({ description: 'Limit (default 10, max 100)', example: 10, minimum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  limit?: number = 10;

  @ApiPropertyOptional({ description: 'Offset for pagination', example: 0, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  offset?: number = 0;
}


export class UserJourneyProgressDto {
  @ApiProperty({ description: 'Course tracking status', enum: ['not_started', 'started', 'incomplete', 'submitted', 'completed', 'not_eligible'] })
  courseTrackStatus: string;
  @ApiProperty({ description: 'Number of lessons completed by user' })
  completedLessons: number;
  @ApiProperty({ description: 'Total number of lessons in course (from track)' })
  noOfLessons: number;
  @ApiProperty({ description: 'Progress percentage 0-100' })
  progress: number;
  @ApiPropertyOptional({ description: 'Last accessed date' })
  lastAccessedDate?: string | null;
  @ApiProperty({ description: 'Whether certificate has been issued' })
  certificateIssued: boolean;
  @ApiPropertyOptional({
    description:
      'Final assessment lesson outcome: pass/fail from assessment testAttempts.result (P/F) when lesson_track is submitted; submitted = test submitted but result/score not finalized in assessment DB; null if N/A or in progress on LMS.',
    enum: ['pass', 'fail', 'submitted'],
    nullable: true,
  })
  assessmentOutcome?: 'pass' | 'fail' | 'submitted' | null;
}

export class UserJourneyItemDto {
  @ApiProperty() courseId: string;
  @ApiProperty({ description: 'Course name (display title)' }) name: string;
  @ApiPropertyOptional() title: string;
  @ApiPropertyOptional() alias?: string;
  @ApiPropertyOptional() shortDescription?: string;
  @ApiPropertyOptional() description?: string;
  @ApiPropertyOptional() image?: string;
  @ApiProperty({ description: 'Course track status: not_started | started | incomplete | submitted | completed | not_eligible' })
  status: string;
  @ApiProperty({ description: 'Progress percentage 0-100 from course_track' })
  progress: number;
  @ApiPropertyOptional() params?: Record<string, any>;
  @ApiPropertyOptional() ordering?: number;
  @ApiProperty({ description: 'Total number of event-type lessons in this course' }) totalEventLessons: number;
  @ApiProperty({ description: 'True if user has completed at least one event-type lesson in this course' }) isAttendedOneEvent: boolean;
  @ApiProperty({ description: 'Detailed progress (completedLessons, noOfLessons, lastAccessedDate, certificateIssued)', type: UserJourneyProgressDto })
  progressDetail: UserJourneyProgressDto;
}

export class UserJourneyResponseDto {
  @ApiProperty({ description: 'List of enrolled courses with event attendance flags', type: [UserJourneyItemDto] })
  courses: UserJourneyItemDto[];

  @ApiProperty({ description: 'Total number of enrolled courses for user in cohort' })
  totalElements: number;

  @ApiProperty({ description: 'Pagination offset' })
  offset: number;

  @ApiProperty({ description: 'Pagination limit' })
  limit: number;
}
