import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AspireLeaderController } from './aspire-leader.controller';
import { AspireLeaderService } from './aspire-leader.service';
import { TenantModule } from '../common/tenant/tenant.module';
import { CacheModule } from '../cache/cache.module';
import { TrackingModule } from '../tracking/tracking.module';
import { Course } from '../courses/entities/course.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { CourseTrack } from '../tracking/entities/course-track.entity';
import { LessonTrack } from '../tracking/entities/lesson-track.entity';
import { UserEnrollment } from '../enrollments/entities/user-enrollment.entity';
import { Media } from '../media/entities/media.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      Course,
      Lesson,
      CourseTrack,
      LessonTrack,
      UserEnrollment,
      Media,
    ]),
    TenantModule,
    CacheModule,
    TrackingModule
  ],
  controllers: [AspireLeaderController],
  providers: [AspireLeaderService],
  exports: [AspireLeaderService],
})
export class AspireLeaderModule {} 